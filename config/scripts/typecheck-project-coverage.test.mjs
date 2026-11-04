import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { TYPECHECK_PROJECTS } from './run-typecheck-projects-in-parallel.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const isTest = (file) => /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/.test(file)
const projects = TYPECHECK_PROJECTS.filter((project) => project.config.startsWith('config/')).map(
  ({ config }) => {
    const parsed = ts.getParsedCommandLineOfConfigFile(resolve(root, config), undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      }
    })
    if (!parsed || parsed.errors.length) {
      throw new Error(`Cannot parse ${config}`)
    }
    return { config, files: new Set(parsed.fileNames.map((file) => resolve(file))) }
  }
)

function typedFiles(directory) {
  return globSync(`${directory}/**/*`, { cwd: root }).filter((file) =>
    /\.(?:[cm]?ts|tsx)$/.test(file)
  )
}

describe('typecheck project coverage', () => {
  it('checks the real CLI coordinator-mail integration in exactly one mixed project', () => {
    const file = resolve(root, 'src/main/runtime/structured-chat-coordinator-mail.test.ts')
    expect(
      projects.filter((project) => project.files.has(file)).map((project) => project.config)
    ).toEqual(['config/tsconfig.test.pane-launch.json'])
  })

  it('keeps CLI tests in the scheduled CLI typecheck project', () => {
    const project = projects.find(({ config }) => config === 'config/tsconfig.tc.cli.json')
    expect(project).toBeDefined()
    const tests = typedFiles('src/cli').filter(isTest)
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter((file) => !project.files.has(resolve(root, file)))).toEqual([])
  })

  it('checks every shared test exactly once, in the scheduled Node project', () => {
    const tests = typedFiles('src/shared').filter(isTest)
    expect(tests.length).toBeGreaterThan(0)
    const violations = tests.flatMap((file) => {
      const owners = projects.filter((project) => project.files.has(resolve(root, file)))
      return owners.length === 1 && owners[0].config === 'config/tsconfig.node.json'
        ? []
        : [{ file, owners: owners.map((owner) => owner.config) }]
    })
    expect(violations).toEqual([])
  })

  it('keeps all shared production files in every root typecheck project', () => {
    const files = typedFiles('src/shared').filter((file) => !isTest(file))
    expect(files.length).toBeGreaterThan(0)
    const missing = projects.flatMap((project) =>
      files
        .filter((file) => !project.files.has(resolve(root, file)))
        .map((file) => ({ config: project.config, file }))
    )
    expect(missing).toEqual([])
  })
  it('keeps whole joined roots uniquely in pane and out of both composite web owners', () => {
    const roots = [
      'mobile/src/worktree/project-sections-owner-recovery.test.ts',
      'src/main/persistence/applying-settings/project-grouping-peer-roundtrip.test.ts',
      'src/renderer/src/app-shell/project-grouping-authored-peer-writes.test.tsx',
      'src/renderer/src/components/sidebar/worktree-list/controls/SidebarRepositoryFilterSection.test.tsx',
      'src/renderer/src/components/sidebar/project-group-actions-test-fixtures.ts',
      'src/renderer/src/components/sidebar/qualified-group-actions-lifetime.test.tsx',
      'src/renderer/src/components/sidebar/qualified-group-actions-scaling.test.tsx',
      'src/renderer/src/components/sidebar/qualified-group-actions.test.tsx',
      'src/renderer/src/components/sidebar/qualified-notice-shipping-boundaries.test.tsx',
      'src/renderer/src/components/task-page/task-page-concrete-source-controls.test.tsx',
      'src/renderer/src/runtime/project-grouping-owner-publication.test-fixture.tsx',
      'src/renderer/src/runtime/project-grouping-owner-publication.test.tsx',
      'src/renderer/src/store/repos/repo-removal.test.ts',
      'src/renderer/src/web/project-grouping-authenticated-peers.test.ts'
    ]
    const broadWeb = ts.getParsedCommandLineOfConfigFile(
      resolve(root, 'config/tsconfig.web.json'),
      undefined,
      ts.sys
    )
    expect(broadWeb.errors).toEqual([])
    for (const file of roots) {
      const absolute = resolve(root, file)
      expect(
        projects.filter((project) => project.files.has(absolute)).map((project) => project.config)
      ).toEqual(['config/tsconfig.test.pane-launch.json'])
      expect(broadWeb.fileNames).not.toContain(absolute)
    }
    const helper = resolve(root, 'config/scripts/renderer-test-assets.ts')
    expect(
      projects.filter((project) => project.files.has(helper)).map(({ config }) => config)
    ).toEqual(['config/tsconfig.node.json'])
  })

  it('preserves discovery precedence, separate Mobile roots and combined native callers', () => {
    const read = (file) => JSON.parse(readFileSync(resolve(root, file), 'utf8'))
    expect(read('tsconfig.json').references).toEqual([
      { path: './config/tsconfig.node.json' },
      { path: './config/tsconfig.web.json' },
      { path: './config/tsconfig.test.pane-launch.json' }
    ])
    expect(read('config/tsconfig.test.mobile-project-controls.json').files).toEqual([
      '../mobile/src/mobile-web-shell/mobile-web-shell-project-controls.test.ts',
      '../mobile/src/mobile-web-shell/mobile-web-shell-nested-project-filter.test.ts',
      '../mobile/src/components/new-workspace-owner-controls.test.tsx',
      '../.cache/typecheck/mobile-project-controls-host/src/renderer/src/env.d.ts',
      '../.cache/typecheck/mobile-project-controls-host/src/preload/api-types.d.ts',
      '../src/types/build-constants.d.ts'
    ])
    const scripts = read('package.json').scripts
    const pane = 'tsc --noEmit -p config/tsconfig.test.pane-launch.json'
    expect(scripts['typecheck:tsc'].split(' && ').filter((command) => command === pane)).toEqual([
      pane
    ])
    for (const command of ['tc:node', 'tc:web', 'typecheck:tsc:node', 'typecheck:tsc:web']) {
      expect(scripts[command]).not.toContain('pane-launch')
    }
  })
})
