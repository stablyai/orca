import { runProcessSync } from '@orca/process-host'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('uses recorded imports in both runtimes and retains cold, new, and global-input tests', () => {
  const root = process.cwd()
  mkdirSync(join(root, '.tmp'), { recursive: true })
  const directory = mkdtempSync(join(root, '.tmp', 'vitest-affected-'))
  const config = join(directory, 'vitest.config.mjs')
  const report = join(directory, 'report.json')
  const transformed = join(directory, 'transformed.jsonl')
  const input = join(directory, 'value.ts')
  const runtimes = ['bun', 'node-runtime']
  const localPath = (file) => relative(root, file).replaceAll('\\', '/')
  function writeTest(runtime, name, imported = false) {
    const file = join(directory, runtime, `${name}.test.ts`)
    writeFileSync(
      file,
      `
      import { expect, it } from 'vitest'
      ${imported ? "import { value } from '../value'" : 'const value = 1'}
      it('runs under ${runtime}', () => {
        expect(value).toBe(1)
        expect(Boolean(process.versions.bun)).toBe(${runtime === 'bun'})
      })
    `
    )
    return file
  }
  try {
    writeFileSync(input, 'export const value = 1')
    const affected = []
    const unrelated = []
    for (const runtime of runtimes) {
      mkdirSync(join(directory, runtime))
      affected.push(writeTest(runtime, 'affected', true))
      unrelated.push(writeTest(runtime, 'unrelated'))
    }
    writeFileSync(
      config,
      `
      import base from ${JSON.stringify(pathToFileURL(resolve('config/vitest.config.ts')).href)}
      import { appendFileSync } from 'node:fs'
      export default {
        ...base,
        cacheDir: ${JSON.stringify(join(directory, 'cache'))},
        plugins: [...base.plugins, {
          name: 'observe-affected-test-transforms',
          transform(code, id) {
            if (id.replaceAll('\\\\', '/').startsWith(${JSON.stringify(directory.replaceAll('\\', '/'))})) {
              appendFileSync(${JSON.stringify(transformed)}, JSON.stringify(id) + '\\n')
            }
          }
        }],
        test: {
          ...base.test,
          maxWorkers: 1,
          projects: base.test.projects
            .filter(project => ${JSON.stringify(runtimes)}.includes(project.test.name))
            .map(project => ({
              ...project,
              test: {
                ...project.test,
                include: [${JSON.stringify(localPath(directory))} + '/' + project.test.name + '/*.test.ts'],
                exclude: []
              }
            }))
        }
      }
    `
    )
    function run(changed) {
      writeFileSync(transformed, '')
      const result = runProcessSync({
        program: process.execPath,
        args: [
          resolve('config/scripts/run-vitest.mjs'),
          'related',
          '--run',
          localPath(changed),
          '--config',
          config,
          '--reporter=json',
          '--outputFile',
          report
        ],
        cwd: root,
        env: { ...process.env, CI: '', ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 60_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
      const output = JSON.parse(readFileSync(report, 'utf8'))
      expect(output.success).toBe(true)
      return output.testResults.map(({ name }) => name.replaceAll('\\', '/')).sort()
    }
    const normalize = (files) => files.map((file) => file.replaceAll('\\', '/')).sort()
    expect(run(input)).toEqual(normalize([...affected, ...unrelated]))
    expect(run(input)).toEqual(normalize(affected))
    const transforms = readFileSync(transformed, 'utf8')
    for (const file of unrelated) {
      expect(transforms).not.toContain(JSON.stringify(file.replaceAll('\\', '/')))
    }
    const fresh = writeTest(runtimes[0], 'new')
    expect(run(input)).toEqual(normalize([...affected, fresh]))
    expect(run(join(root, 'pnpm-lock.yaml'))).toEqual(normalize([...affected, ...unrelated, fresh]))
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}, 180_000)
