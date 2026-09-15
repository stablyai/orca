import test from 'node:test'
import assert from 'node:assert/strict'
import { serve, sanitizeDiagnostics, startupDiagnostics } from './remote-runtime.mjs'

test('early launcher failure retains stderr while successful wrapper exit is not server death', async () => {
  const box = {
    readFileToBuffer: async () => Buffer.from('test-owner'),
    writeFiles: async () => {},
    currentSession: () => ({ sessionId: 'session_test' }),
    domain: () => 'https://test.example',
    runCommand: async ({ cmd }) => {
      if (cmd === 'git') {
        return { exitCode: 0 }
      }
      if (cmd === 'bash') {
        return {
          wait: async () => ({ exitCode: 127, stderr: async () => 'flock: command not found' })
        }
      }
      return { exitCode: 1 }
    }
  }
  await assert.rejects(serve(box, 'test-owner'), (error) => {
    assert.equal(error.startupDiagnostics, 'flock: command not found')
    return /exited with code 127/.test(error.message)
  })
  let probes = 0
  box.runCommand = async ({ cmd }) => {
    if (cmd === 'git') {
      return { exitCode: 0 }
    }
    if (cmd === 'bash') {
      return { wait: async () => ({ exitCode: 0 }) }
    }
    return ++probes === 1
      ? { exitCode: 1 }
      : {
          exitCode: 0,
          output: async () =>
            JSON.stringify({ pairingCode: 'test-pairing', projectRoot: '/vercel/project' })
        }
  }
  assert.equal((await serve(box, 'test-owner')).pairingCode, 'test-pairing')
  assert.equal(sanitizeDiagnostics('orca:private-pairing'), '[REDACTED_PAIRING]')
})

test('unavailable diagnostic files do not replace the startup failure', async () => {
  assert.match(
    await startupDiagnostics({
      readFileToBuffer: async () => {
        throw new Error('HTTP 410')
      }
    }),
    /original startup error retained/
  )
})
