const {
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  IOSConfig
} = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')
const {
  SCENE_DELEGATE_SOURCE,
  applySceneInfoPlist,
  rewriteAppDelegate
} = require('./ios-uikit-scene-lifecycle-transform')

// Why: Expo still emits an AppDelegate-owned UIWindow, which iOS 27 aborts.
// Apply a deterministic SceneDelegate migration during every prebuild.

function withSceneInfoPlist(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults = applySceneInfoPlist(cfg.modResults)
    return cfg
  })
}

function withSceneDelegateFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.platformProjectRoot
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
      const appDir = path.join(projectRoot, projectName)

      fs.writeFileSync(path.join(appDir, 'SceneDelegate.swift'), SCENE_DELEGATE_SOURCE)

      const appDelegatePath = path.join(appDir, 'AppDelegate.swift')
      if (fs.existsSync(appDelegatePath)) {
        const original = fs.readFileSync(appDelegatePath, 'utf8')
        const rewritten = rewriteAppDelegate(original)
        if (rewritten !== original) {
          fs.writeFileSync(appDelegatePath, rewritten)
        }
      }

      return cfg
    }
  ])
}

function withSceneDelegateXcodeProject(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
    ensureSceneDelegateBuildSource(
      project,
      projectName,
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup
    )

    return cfg
  })
}

function readProjectSection(project, key) {
  const accessor = project[key]
  return typeof accessor === 'function' ? accessor.call(project) : accessor
}

function sceneDelegateFileReferenceIds(project) {
  const section = readProjectSection(project, 'pbxFileReferenceSection') ?? {}
  const ids = new Set()
  for (const [id, entry] of Object.entries(section)) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const candidate = typeof entry.path === 'string' ? entry.path : entry.name
    if (isSceneDelegatePath(candidate)) {
      ids.add(id)
    }
  }
  return ids
}

function isSceneDelegatePath(value) {
  if (typeof value !== 'string') {
    return false
  }
  const normalized = value.replace(/^"|"$/g, '').replace(/\\/g, '/')
  return normalized === 'SceneDelegate.swift' || normalized.endsWith('/SceneDelegate.swift')
}

function isSceneDelegateInApplicationSources(project) {
  const fileReferenceIds = sceneDelegateFileReferenceIds(project)
  if (fileReferenceIds.size === 0 || typeof project.getTarget !== 'function') {
    return false
  }
  const applicationTarget = project.getTarget('com.apple.product-type.application')
  if (!applicationTarget?.uuid || typeof project.pbxSourcesBuildPhaseObj !== 'function') {
    return false
  }
  const sources = project.pbxSourcesBuildPhaseObj(applicationTarget.uuid)
  const buildFiles = readProjectSection(project, 'pbxBuildFileSection') ?? {}
  return Boolean(
    sources?.files?.some((source) => {
      const buildFile = buildFiles[source?.value]
      return buildFile && fileReferenceIds.has(buildFile.fileRef)
    })
  )
}

function ensureSceneDelegateBuildSource(project, projectName, addBuildSourceFileToGroup) {
  if (!isSceneDelegateInApplicationSources(project)) {
    const hasFileReference = sceneDelegateFileReferenceIds(project).size > 0
    if (!hasFileReference) {
      // Why: linking errors must abort prebuild; writing an uncompiled Swift
      // file leaves AppDelegate referring to a SceneDelegate the target lacks.
      addBuildSourceFileToGroup({
        filepath: `${projectName}/SceneDelegate.swift`,
        groupName: projectName,
        project
      })
    }
  }

  if (!isSceneDelegateInApplicationSources(project)) {
    throw new Error(
      'ios-uikit-scene-lifecycle: SceneDelegate.swift was not linked to the application Sources build phase'
    )
  }
}

function withIosUIKitSceneLifecycle(config) {
  config = withSceneInfoPlist(config)
  config = withSceneDelegateFile(config)
  config = withSceneDelegateXcodeProject(config)
  return config
}

module.exports = withIosUIKitSceneLifecycle
module.exports.ensureSceneDelegateBuildSource = ensureSceneDelegateBuildSource
