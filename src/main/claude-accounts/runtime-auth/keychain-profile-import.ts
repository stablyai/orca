import { runProcess } from '@orca/process-host'
import {
  claudeKeychainService,
  getKeychainUser,
  readActiveClaudeKeychainCredentialsStrict
} from './keychain'

export async function writeClaudeProfileKeychainCredentials(
  configDir: string,
  contents: string
): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Claude Keychain storage requires macOS.')
  }
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const input = `add-generic-password -U -s ${quote(claudeKeychainService(configDir))} -a ${quote(getKeychainUser())} -w ${quote(JSON.stringify(JSON.parse(contents)))}\n`
  if (Buffer.byteLength(input) > 4096) {
    throw new Error(
      'Claude credentials exceed the macOS import limit. Sign in to this account instead.'
    )
  }
  try {
    const result = await runProcess({
      program: '/usr/bin/security',
      args: ['-i'],
      input,
      timeoutMs: 3000,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated || result.signal) {
      throw new Error('Keychain update failed')
    }
  } catch {
    throw new Error('The imported Claude login could not be saved in macOS Keychain.')
  }
  const actual = await readActiveClaudeKeychainCredentialsStrict(configDir)
  if (!actual || JSON.stringify(JSON.parse(actual)) !== JSON.stringify(JSON.parse(contents))) {
    throw new Error('The imported Claude Keychain login could not be verified.')
  }
}
