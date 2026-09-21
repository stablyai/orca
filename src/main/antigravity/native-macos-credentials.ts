import { runProcess } from '../../shared/child-process/run-process'
import {
  decodeAntigravityKeychainValue,
  encodeAntigravityKeychainValue,
  parseAntigravityNativeCredential,
  type AntigravityNativeCredential
} from './native-credential-codec'

function requireMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('The Antigravity macOS credential store is unavailable on this host.')
  }
}

async function runSecurity(args: string[], input?: string) {
  try {
    return await runProcess({
      program: '/usr/bin/security',
      args,
      input,
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024
    })
  } catch {
    // Child-process errors may embed credential-bearing output.
    throw new Error('The Antigravity macOS credential store could not be accessed.')
  }
}

export async function readAntigravityMacOSCredential(): Promise<AntigravityNativeCredential | null> {
  requireMacOS()
  const result = await runSecurity([
    'find-generic-password',
    '-s',
    'gemini',
    '-a',
    'antigravity',
    '-w'
  ])
  if (!result.timedOut && !result.signal && !result.outputTruncated) {
    if (result.code === 44) {
      return null
    }
    if (result.code === 0) {
      return parseAntigravityNativeCredential(decodeAntigravityKeychainValue(result.stdout))
    }
  }
  throw new Error('The Antigravity macOS credential store could not be read.')
}

export async function writeAntigravityMacOSCredential(contents: string): Promise<void> {
  requireMacOS()
  parseAntigravityNativeCredential(contents)
  const encoded = encodeAntigravityKeychainValue(contents)
  const input = `add-generic-password -U -s gemini -a antigravity -w ${encoded}\n`
  // security's interactive command buffer is limited; never risk a truncated credential write.
  if (Buffer.byteLength(input) > 4096) {
    throw new Error('Antigravity credentials exceed the macOS credential command limit.')
  }
  const result = await runSecurity(['-i'], input)
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('The Antigravity macOS credential store could not be updated.')
  }
  const actual = await readAntigravityMacOSCredential()
  if (actual?.contents !== contents) {
    throw new Error('The Antigravity macOS credential update could not be verified.')
  }
}
