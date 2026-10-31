import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tests = [
  ...globSync('resources/claude-rich-output/reply-markdown/hooks/*.test.mjs', { cwd: root }),
  ...globSync('resources/claude-rich-output/reply-media/render/*.test.mjs', { cwd: root })
]
function run(program, args) {
  const result = runProcessSync({ program, args, cwd: root, stdio: 'inherit', timeoutMs: 180_000 })
  if (result.code !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${describeProcessFailure(result)}`)
  }
}
if (tests.length === 0) {
  throw new Error('No rich output renderer tests found')
}
run(process.execPath, ['--test', ...tests])
for (const module of ['reply-markdown', 'reply-media']) {
  const path = `resources/claude-rich-output/${module}`
  run('claude', ['plugin', 'validate', path])
  run('claude', ['plugin', 'test', path])
}
