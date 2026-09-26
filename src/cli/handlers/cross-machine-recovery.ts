import { resolve } from 'node:path'
import {
  MAX_RECOVERY_DESCRIPTOR_BYTES,
  type RecoveryDescribeResult,
  type RecoveryExportResult,
  type RecoveryImportResult,
  type RecoveryListResult,
  type RecoveryPathMapping,
  type RecoveryResumeResult
} from '../../shared/cross-machine-recovery-descriptor'
import type { RecoveryActivityResult } from '../../shared/cross-machine-recovery-presentation-types'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'

function formatRecoveryJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function descriptorTooLarge(): RuntimeClientError {
  return new RuntimeClientError(
    'recovery_descriptor_too_large',
    `Recovery descriptors are limited to ${MAX_RECOVERY_DESCRIPTOR_BYTES} bytes.`
  )
}

async function readStdinWithinLimit(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > maxBytes) {
      throw descriptorTooLarge()
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readDescriptorText(source: string, cwd: string): Promise<string> {
  if (source === '-') {
    return await readStdinWithinLimit(MAX_RECOVERY_DESCRIPTOR_BYTES)
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(
      resolve(cwd, source),
      MAX_RECOVERY_DESCRIPTOR_BYTES
    )
    return buffer.toString('utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new RuntimeClientError('invalid_argument', `Descriptor file not found: ${source}`)
    }
    throw error instanceof NodeFileReadTooLargeError ? descriptorTooLarge() : error
  }
}

async function readDescriptor(source: string, cwd: string): Promise<unknown> {
  const text = await readDescriptorText(source, cwd)
  try {
    return JSON.parse(text)
  } catch {
    throw new RuntimeClientError('recovery_descriptor_invalid', 'Descriptor is not valid JSON.')
  }
}

function parseMapping(flag: string, entry: string): RecoveryPathMapping {
  const separator = entry.indexOf('=')
  if (separator <= 0 || separator === entry.length - 1) {
    throw new RuntimeClientError('invalid_argument', `--${flag} expects <from>=<to>, got ${entry}`)
  }
  return { from: entry.slice(0, separator), to: entry.slice(separator + 1) }
}

// Why unknown: the host validates the key strictly; the CLI only has to carry the JSON.
function parseBindingKey(entry: string): unknown {
  try {
    return JSON.parse(entry)
  } catch {
    throw new RuntimeClientError(
      'invalid_argument',
      `--resume-key expects binding key JSON, got ${entry}`
    )
  }
}

export const CROSS_MACHINE_RECOVERY_HANDLERS: Record<string, CommandHandler> = {
  'recovery describe': async ({ client, json }) => {
    const result = await client.call<RecoveryDescribeResult>('crossMachineRecovery.describe', {})
    printResult(result, json, formatRecoveryJson)
  },
  'recovery export': async ({ client, flags, json }) => {
    const result = await client.call<RecoveryExportResult>('crossMachineRecovery.export', {
      worktree: getRequiredStringFlag(flags, 'worktree')
    })
    printResult(result, json, formatRecoveryJson)
  },
  'recovery import': async ({ client, flags, cwd, json }) => {
    const pathMap = getRepeatedStringFlag(flags, 'path-map').map((entry) =>
      parseMapping('path-map', entry)
    )
    const sessionIdMap = getRepeatedStringFlag(flags, 'session-map').map((entry) =>
      parseMapping('session-map', entry)
    )
    const resume = [
      ...getRepeatedStringFlag(flags, 'resume'),
      ...getRepeatedStringFlag(flags, 'resume-key').map(parseBindingKey)
    ]
    const preferClientInstanceId = getOptionalStringFlag(flags, 'prefer-client')
    const result = await client.call<RecoveryImportResult>('crossMachineRecovery.import', {
      descriptor: await readDescriptor(getRequiredStringFlag(flags, 'descriptor'), cwd),
      checkoutPath: resolve(cwd, getRequiredStringFlag(flags, 'checkout')),
      checkpointId: getRequiredStringFlag(flags, 'checkpoint'),
      ...(pathMap.length > 0 ? { pathMap } : {}),
      ...(sessionIdMap.length > 0 ? { sessionIdMap } : {}),
      ...(resume.length > 0 ? { resume } : {}),
      ...(preferClientInstanceId ? { preferClientInstanceId } : {}),
      ...(flags.get('activate') === true ? { activate: true } : {}),
      ...(flags.get('register-repo') === true ? { registerRepo: true } : {}),
      ...(flags.get('dry-run') === true ? { dryRun: true } : {})
    })
    printResult(result, json, formatRecoveryJson)
  },
  'recovery resume': async ({ client, flags, json }) => {
    const session = getOptionalStringFlag(flags, 'session')
    const key = getOptionalStringFlag(flags, 'resume-key')
    if ((session === undefined) === (key === undefined)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass exactly one of --session or --resume-key.'
      )
    }
    const result = await client.call<RecoveryResumeResult>('crossMachineRecovery.resume', {
      worktree: getRequiredStringFlag(flags, 'worktree'),
      binding: key === undefined ? session : parseBindingKey(key),
      presentation: flags.get('focus') === true ? 'focused' : 'background'
    })
    printResult(result, json, formatRecoveryJson)
  },
  'recovery list': async ({ client, flags, json }) => {
    const worktree = getOptionalStringFlag(flags, 'worktree')
    const result = await client.call<RecoveryListResult>(
      'crossMachineRecovery.list',
      worktree ? { worktree } : {}
    )
    printResult(result, json, formatRecoveryJson)
  },
  'recovery activity': async ({ client, json }) => {
    const result = await client.call<RecoveryActivityResult>('crossMachineRecovery.activity', {})
    printResult(result, json, formatRecoveryJson)
  }
}
