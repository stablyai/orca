import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod'

const MAX_FILE_BYTES = 5 * 1024 * 1024

export function resolveLanguagePath(path: string, base: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(base, path)
}

export async function extensionResourcePath(base: string, path: string): Promise<string> {
  const root = await realpath(base)
  const target = await realpath(resolve(base, path))
  const offset = relative(root, target)
  if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)) {
    throw new Error(`Extension resource escapes its directory: ${path}`)
  }
  return target
}

export async function readLanguageJson(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error(`Expected a regular JSON file smaller than 5 MiB: ${path}`)
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) {
        break
      }
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > MAX_FILE_BYTES) {
      throw new Error(`Language file exceeds 5 MiB: ${path}`)
    }
    const errors: ParseError[] = []
    const value: unknown = parse(buffer.toString('utf8', 0, bytesRead), errors, {
      allowTrailingComma: true
    })
    if (errors.length) {
      throw new Error(`Invalid JSON in ${path} at offset ${errors[0].offset}`)
    }
    return value
  } finally {
    await file.close()
  }
}

const pair = z.tuple([z.string(), z.string()])
const closingPair = z.union([
  pair.transform(([open, close]) => ({ open, close })),
  z.object({ open: z.string(), close: z.string(), notIn: z.array(z.string()).optional() })
])

export const languageConfigurationSchema = z.object({
  comments: z
    .object({
      lineComment: z
        .union([z.string(), z.object({ comment: z.string() }).transform((value) => value.comment)])
        .optional(),
      blockComment: pair.optional()
    })
    .optional(),
  brackets: z.array(pair).optional(),
  autoClosingPairs: z.array(closingPair).optional(),
  surroundingPairs: z.array(closingPair).optional()
})

export const languageMetadataSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
  aliases: z.array(z.string()).max(32).optional(),
  extensions: z
    .array(z.string().regex(/^\.[^/\\]+$/))
    .max(128)
    .optional(),
  filenames: z
    .array(z.string().regex(/^[^/\\]+$/))
    .max(128)
    .optional(),
  configuration: z.string().optional()
})
