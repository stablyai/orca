import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRendererProcess } from './process.mjs'

test('a silent converter failure reports the program and exit status', () => {
  const result = runRendererProcess(process.execPath, ['-e', 'process.exit(17)'])
  assert.equal(result.status, 17)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /exited with status 17/)
})

test('a converter diagnostic is preserved and successful silence stays silent', () => {
  const failed = runRendererProcess(process.execPath, [
    '-e',
    'process.stderr.write("bad input");process.exit(2)'
  ])
  assert.equal(failed.stderr, 'bad input')
  const success = runRendererProcess(process.execPath, ['-e', 'process.stdout.write("ok")'])
  assert.equal(success.status, 0)
  assert.equal(success.stdout, 'ok')
  assert.equal(success.stderr, '')
})
