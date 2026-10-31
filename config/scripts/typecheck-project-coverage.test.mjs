import { globSync } from 'node:fs'
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
  it('keeps CLI tests in the scheduled CLI typecheck project', () => {
    const project = projects.find(({ config }) => config === 'config/tsconfig.tc.cli.json')
    expect(project).toBeDefined()
    const tests = typedFiles('src/cli').filter(isTest)
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter((file) => !project.files.has(resolve(root, file)))).toEqual([])
  })

  it('assigns the combined pane launch integration to its typed cross-process project', () => {
    const suite = resolve(
      root,
      'src/renderer/src/components/terminal-pane/pty-agent-pane-launch.test.ts'
    )
    expect(
      projects.filter((project) => project.files.has(suite)).map((project) => project.config)
    ).toEqual(['config/tsconfig.test.pane-launch.json'])
    const combined = projects.find(
      (project) => project.config === 'config/tsconfig.test.pane-launch.json'
    )
    expect(combined.files.has(resolve(root, 'src/types/build-constants.d.ts'))).toBe(true)
    expect(combined.files.has(resolve(root, 'src/renderer/src/env.d.ts'))).toBe(true)
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
})
