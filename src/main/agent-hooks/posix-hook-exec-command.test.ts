import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { wrapPosixHookCommandForExec } from './posix-hook-command'
import { shlexSplit } from './posix-hook-exec-command.test-fixture'

it('rejects incomplete command quoting', () => {
  expect(() => shlexSplit("/bin/sh -c 'printf ok")).toThrow(/unbalanced/)
  expect(() => shlexSplit('/bin/sh -c foo\\')).toThrow(/trailing backslash/)
})

it('preserves quoted backslashes and escaped single quotes', () => {
  expect(shlexSplit(String.raw`cmd "a\q" 'a'\''b'`)).toEqual(['cmd', 'a\\q', "a'b"])
})

describe.skipIf(process.platform === 'win32')('POSIX exec hook command', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-exec-hook-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it.each(['present', 'missing', 'not-executable', 'missing-env'])(
    'preserves the gate response with a %s script',
    async (state) => {
      const script = join(root, "hook 'quoted' $literal `name` 日本語.sh")
      writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$ORCA_TEST_EVENT"\ncat >/dev/null\n', {
        mode: 0o700
      })
      if (state === 'missing') {
        rmSync(script)
      }
      if (state === 'not-executable') {
        chmodSync(script, 0o600)
      }
      const response = '{"decision":"ask"}'
      const command = wrapPosixHookCommandForExec(
        script,
        { ORCA_TEST_EVENT: 'managed hook ran' },
        { fallbackStdout: response, requiredEnvVar: 'ORCA_TEST_REQUIRED' }
      )
      const [program, ...args] = shlexSplit(command)
      expect(program).toBe('/bin/sh')
      if (!program) {
        throw new Error('missing hook program')
      }
      for (const route of ['exec', 'shell']) {
        const result = await runProcess({
          program: route === 'exec' ? program : '/bin/sh',
          args: route === 'exec' ? args : ['-c', command],
          input: '{"toolCall":{"name":"read_file"}}',
          env: { ...process.env, ORCA_TEST_REQUIRED: state === 'missing-env' ? '' : '1' },
          timeoutMs: 5000
        })
        expect(result).toMatchObject({
          code: 0,
          stdout: `${state === 'present' ? 'managed hook ran' : response}\n`,
          stderr: '',
          timedOut: false
        })
      }
    }
  )
})
