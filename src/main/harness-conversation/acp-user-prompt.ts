import { basename } from 'node:path'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { providerAttachmentUri } from './provider-image-input'

export function acpUserPrompt(text: string, imagePaths?: readonly string[]): ContentBlock[] {
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...(imagePaths ?? []).map((path) => ({
      type: 'resource_link' as const,
      uri: providerAttachmentUri(path),
      name: basename(path)
    }))
  ]
}
