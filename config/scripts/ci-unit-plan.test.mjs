import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runProcessSync } from './script-child-process.mjs'
import { FULL_SHARD_COUNT } from './ci-unit-selection.mjs'

it.each([true, false])(
  'plans from a real Git diff, with parent evidence available: %s',
  (withParent) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-unit-plan-'))
    const git = (args) => {
      const result = runProcessSync({ program: 'git', args, cwd: root })
      expect(result.code, result.stderr).toBe(0)
      return result.stdout.trim()
    }
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src/value.ts'), 'export const value = 1')
      writeFileSync(join(root, 'src/consumer.test.ts'), "import './value'")
      writeFileSync(join(root, 'src/unrelated.test.ts'), 'export const unrelated = true')
      git(['init', '--quiet'])
      git(['add', 'src'])
      const commit = [
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ]
      git(commit)
      if (withParent) {
        writeFileSync(join(root, 'src/value.ts'), 'export const value = 2')
        git(['add', 'src'])
        git(commit)
      }
      const sourceSha = git(['rev-parse', 'HEAD'])
      const eventPath = join(root, 'event.json')
      writeFileSync(eventPath, JSON.stringify({ pull_request: { draft: true } }))
      const result = runProcessSync({
        program: process.execPath,
        args: [fileURLToPath(new URL('./ci-unit-plan.mjs', import.meta.url))],
        cwd: root,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_UNIT_SELECTION_MODE: 'selected',
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_SHA: sourceSha,
          ORCA_SHARD_SOURCE_SHA: sourceSha,
          GITHUB_OUTPUT: join(root, 'outputs'),
          GITHUB_STEP_SUMMARY: join(root, 'summary')
        }
      })
      expect(result.code, result.stderr).toBe(0)
      const plan = JSON.parse(readFileSync(join(root, 'ci-shards/unit-selection.json'), 'utf8'))
      expect(plan.sourceSha).toBe(sourceSha)
      expect(plan.mode).toBe(withParent ? 'selected' : 'shadow')
      expect(plan.executionFiles).toEqual(
        withParent ? ['src/consumer.test.ts'] : ['src/consumer.test.ts', 'src/unrelated.test.ts']
      )
      expect(plan.reason).toBe(
        withParent
          ? 'Transitive imports plus indirect-input consumers'
          : 'Error: Changed paths unavailable'
      )
      expect(plan.shards).toHaveLength(withParent ? 1 : FULL_SHARD_COUNT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
