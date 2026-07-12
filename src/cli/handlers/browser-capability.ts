import type {
  BrowserCapabilityCreateResult,
  BrowserCapabilityRevokeResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { writeBrowserCapabilityMetadata } from '../runtime/browser-capability-metadata'

const DEFAULT_CAPABILITY_TTL_MS = 30 * 60 * 1_000

export const BROWSER_CAPABILITY_HANDLERS: Record<string, CommandHandler> = {
  'tab capability create': async ({ flags, client, json }) => {
    const page = getRequiredStringFlag(flags, 'page')
    const output = getRequiredStringFlag(flags, 'output')
    const worktree = getOptionalStringFlag(flags, 'worktree')
    const ttlMs = getOptionalPositiveIntegerFlag(flags, 'ttl-ms') ?? DEFAULT_CAPABILITY_TTL_MS
    const sourceMetadata = client.getLocalMetadata()
    const result = await client.call<BrowserCapabilityCreateResult>('browser.capabilityCreate', {
      page,
      ttlMs,
      ...(worktree ? { worktree } : {})
    })
    let metadataPath: string
    try {
      metadataPath = writeBrowserCapabilityMetadata(output, sourceMetadata, result.result.token)
    } catch (error) {
      await client.call('browser.capabilityRevoke', { id: result.result.id }).catch(() => undefined)
      throw error
    }
    printResult(
      { ...result, result: { ...result.result, token: '[redacted]', metadataPath } },
      json,
      (value) =>
        `Created browser capability ${value.id} for ${value.browserPageId} at ${value.metadataPath}`
    )
  },
  'tab capability revoke': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'capability')
    const result = await client.call<BrowserCapabilityRevokeResult>('browser.capabilityRevoke', {
      id
    })
    printResult(result, json, (value) =>
      value.revoked
        ? `Revoked browser capability ${value.id}`
        : `Browser capability ${value.id} was not active`
    )
  }
}
