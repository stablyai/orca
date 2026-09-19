import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_BUN_RUNTIME_FILENAME,
  orcadBunRuntimeFilename,
  orcadArtifactHashPrefix,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames
} from '../../shared/orcad-artifacts'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import {
  materializeCachedOrcadBunRuntime,
  verifyFileSha256,
  type OrcadBunRuntimeMaterializeOptions
} from './orcad-bun-runtime-materializer'

const TemplateTargetSchema = z
  .object({
    targetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    watcherSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    browserName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .optional(),
    browserSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional()
  })
  .refine((target) => Boolean(target.browserName) === Boolean(target.browserSha256), {
    message: 'browserName and browserSha256 must either both be present or both be absent'
  })
const TemplateManifestSchema = z.object({
  schemaVersion: z.literal(2),
  commonSha256: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
  targets: z.record(z.string(), TemplateTargetSchema)
})

type MaterializeOptions = OrcadBunRuntimeMaterializeOptions & {
  templateDir?: string
  cacheRoot?: string
  fetcher?: typeof fetch
  signal?: AbortSignal
}

const materializations = new Map<string, Promise<string>>()

export async function materializeOrcadArtifact(
  target: OrcadBunTarget,
  options: MaterializeOptions = {}
): Promise<string> {
  const templateDir = options.templateDir ?? resolveOrcadTemplateDir()
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const key = `${cacheRoot}\0${target}`
  const existing = materializations.get(key)
  if (existing) {
    return existing
  }
  const pending = materializeOrcadArtifactInner(target, templateDir, cacheRoot, options).finally(
    () => materializations.delete(key)
  )
  materializations.set(key, pending)
  return pending
}

async function materializeOrcadArtifactInner(
  target: OrcadBunTarget,
  templateDir: string,
  cacheRoot: string,
  options: MaterializeOptions
): Promise<string> {
  const manifest = await readTemplateManifest(templateDir)
  await verifyTemplate(templateDir, target, manifest)
  const runtimePath = await materializeCachedOrcadBunRuntime(target, cacheRoot, options)
  return await assembleOrcadArtifact({ templateDir, cacheRoot, target, runtimePath, manifest })
}

export async function assembleOrcadArtifact(args: {
  templateDir: string
  cacheRoot: string
  target: OrcadBunTarget
  runtimePath: string
  manifest?: z.infer<typeof TemplateManifestSchema>
}): Promise<string> {
  const manifest = args.manifest ?? (await readTemplateManifest(args.templateDir))
  await verifyTemplate(args.templateDir, args.target, manifest)
  const sources = artifactSources(args.templateDir, args.target, args.runtimePath, manifest)
  const { fullVersion, sourceHashes } = await computeArtifactIdentity(sources, args.target)
  const targetRoot = join(args.cacheRoot, args.target)
  const targetDir = join(targetRoot, fullVersion)
  if (await isCompleteArtifact(targetDir, fullVersion, sources, sourceHashes)) {
    return targetDir
  }
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })
  const stagingDir = join(targetRoot, `.staging-${process.pid}-${randomUUID()}`)
  try {
    for (const source of sources) {
      const destination = join(stagingDir, source.filename)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source.path, destination)
      if (source.executable && !args.target.startsWith('win32-')) {
        await chmod(destination, 0o755)
      }
    }
    await writeFile(join(stagingDir, ORCAD_VERSION_FILENAME), `${fullVersion}\n`, { mode: 0o600 })
    try {
      await rename(stagingDir, targetDir)
    } catch (error) {
      if (!(await isCompleteArtifact(targetDir, fullVersion, sources, sourceHashes))) {
        throw error
      }
    }
    return targetDir
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function artifactSources(
  templateDir: string,
  target: OrcadBunTarget,
  runtimePath: string,
  manifest: z.infer<typeof TemplateManifestSchema>
): { filename: string; path: string; executable?: boolean }[] {
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new Error(`Packaged orcad template does not support ${target}`)
  }
  const required = orcadArtifactFilenames(target).map((filename) => ({
    filename,
    path:
      filename === orcadBunRuntimeFilename(target)
        ? runtimePath
        : filename === ORCAD_BUILD_TARGET_FILENAME
          ? join(targetDir, ORCAD_BUILD_TARGET_FILENAME)
          : filename.endsWith('watcher.node')
            ? join(targetDir, 'watcher.node')
            : join(templateDir, filename),
    ...(filename === orcadBunRuntimeFilename(target) ? { executable: true } : {})
  }))
  if (!targetManifest.browserName) {
    return required
  }
  return [
    ...required,
    {
      filename: targetManifest.browserName,
      path: join(targetDir, targetManifest.browserName),
      executable: true
    }
  ]
}

async function computeArtifactIdentity(
  sources: { filename: string; path: string }[],
  target: OrcadBunTarget
): Promise<{ fullVersion: string; sourceHashes: Map<string, string> }> {
  const hash = createHash('sha256').update(orcadArtifactHashPrefix(target))
  const sourceHashes = new Map<string, string>()
  for (const source of sources) {
    const sourceHash = createHash('sha256')
    for await (const chunk of createReadStream(source.path)) {
      hash.update(chunk)
      sourceHash.update(chunk)
    }
    sourceHashes.set(source.filename, sourceHash.digest('hex'))
  }
  return {
    fullVersion: `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`,
    sourceHashes
  }
}

async function isCompleteArtifact(
  dir: string,
  fullVersion: string,
  sources: { filename: string }[],
  sourceHashes: Map<string, string>
): Promise<boolean> {
  try {
    if ((await readFile(join(dir, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== fullVersion) {
      return false
    }
    for (const source of sources) {
      if ((await fileSha256(join(dir, source.filename))) !== sourceHashes.get(source.filename)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function readTemplateManifest(
  templateDir: string
): Promise<z.infer<typeof TemplateManifestSchema>> {
  return TemplateManifestSchema.parse(
    JSON.parse(await readFile(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8'))
  )
}

async function verifyTemplate(
  templateDir: string,
  target: OrcadBunTarget,
  manifest: z.infer<typeof TemplateManifestSchema>
): Promise<void> {
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new Error(`Packaged orcad template does not support ${target}`)
  }
  const commonFilenames = orcadArtifactFilenames().filter(
    (filename) =>
      filename !== ORCAD_BUN_RUNTIME_FILENAME &&
      filename !== ORCAD_BUILD_TARGET_FILENAME &&
      !filename.endsWith('watcher.node')
  )
  for (const filename of commonFilenames) {
    const expected = manifest.commonSha256[filename]
    if (!expected) {
      throw new Error(`Packaged orcad template manifest omits ${filename}`)
    }
    await verifyFileSha256(join(templateDir, filename), expected, `orcad template ${filename}`)
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetIdentityPath = join(targetDir, ORCAD_BUILD_TARGET_FILENAME)
  await verifyFileSha256(targetIdentityPath, targetManifest.targetSha256, `${target} build target`)
  if ((await readFile(targetIdentityPath, 'utf8')).trim() !== target) {
    throw new Error(`Packaged orcad template target identity does not match ${target}`)
  }
  await verifyFileSha256(
    join(targetDir, 'watcher.node'),
    targetManifest.watcherSha256,
    `${target} watcher`
  )
  if (targetManifest.browserName && targetManifest.browserSha256) {
    await verifyFileSha256(
      join(targetDir, targetManifest.browserName),
      targetManifest.browserSha256,
      `${target} browser`
    )
  }
}

export function getOrcadTemplateCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_ORCAD_TEMPLATE_PATH) {
    candidates.push(process.env.ORCA_ORCAD_TEMPLATE_PATH)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'orcad-template'))
  }
  const appPath = getAppEnvironment().getAppPath()
  candidates.push(
    join(appPath, 'out', 'orcad-template'),
    join(appPath, 'resources', 'orcad-template')
  )
  return [...new Set(candidates)]
}

function resolveOrcadTemplateDir(): string {
  const found = getOrcadTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error('The packaged orcad deployment template is missing')
  }
  return found
}

export function resetOrcadArtifactMaterializationsForTests(): void {
  materializations.clear()
}
