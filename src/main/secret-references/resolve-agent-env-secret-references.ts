import { runProcess } from '../../shared/child-process/run-process'
import { classifyAgentEnvSecretReferences } from '../../shared/secret-reference'

export type SecretReferenceFailureCode =
  | 'invalid-reference'
  | 'remote-target'
  | 'spawn-failure'
  | 'timeout'
  | 'truncated'
  | 'nonzero-exit'
  | 'empty-output'

export class SecretReferenceResolutionError extends Error {
  readonly envKey: string
  readonly code: SecretReferenceFailureCode

  constructor(envKey: string, code: SecretReferenceFailureCode) {
    super(`Secret reference resolution failed for ${envKey}: ${code}`)
    this.name = 'SecretReferenceResolutionError'
    this.envKey = envKey
    this.code = code
  }
}

export type SecretReferenceResolveTarget = {
  readonly ssh: boolean
  readonly wsl: boolean
}

export async function resolveSecretReferencesIntoChildEnv(input: {
  readonly childEnv: Record<string, string>
  readonly target: SecretReferenceResolveTarget
}): Promise<void> {
  const classification = classifyAgentEnvSecretReferences(input.childEnv)
  if (classification.kind === 'invalid') {
    throw new SecretReferenceResolutionError(classification.keys[0], 'invalid-reference')
  }
  if (classification.kind === 'none') {
    return
  }
  if (input.target.ssh || input.target.wsl) {
    throw new SecretReferenceResolutionError(classification.entries[0].key, 'remote-target')
  }

  const resolvedEntries: (readonly [string, string])[] = []
  for (const { key, reference } of classification.entries) {
    let result
    try {
      result = await runProcess({
        program: 'doppler',
        args: [
          'secrets',
          'get',
          reference.name,
          '--project',
          reference.project,
          '--config',
          reference.config,
          '--plain'
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      throw new SecretReferenceResolutionError(key, 'spawn-failure')
    }
    if (result.timedOut) {
      throw new SecretReferenceResolutionError(key, 'timeout')
    }
    if (result.outputTruncated) {
      throw new SecretReferenceResolutionError(key, 'truncated')
    }
    if (result.code !== 0) {
      throw new SecretReferenceResolutionError(key, 'nonzero-exit')
    }
    const value = result.stdout.replace(/\r?\n$/, '')
    if (value.length === 0) {
      throw new SecretReferenceResolutionError(key, 'empty-output')
    }
    resolvedEntries.push([key, value])
  }

  for (const [key, value] of resolvedEntries) {
    input.childEnv[key] = value
  }
}
