import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const privateText =
  /\/Users\/|\/home\/|[a-z]:[\\/]+Users[\\/]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bhostname\b|\b[\w-]+\.(?:local|lan)\b|signature|subscription_tier|skills?/i

function decodedStrings(value: unknown, depth = 0): string[] {
  if (depth > 8) {
    return []
  }
  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.every(
        (entry) =>
          typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 255
      )
    ) {
      return decodedStrings(Buffer.from(value).toString('utf8'), depth + 1)
    }
    return value.flatMap((entry) => decodedStrings(entry, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...decodedStrings(entry, depth + 1)
    ])
  }
  if (typeof value !== 'string') {
    return []
  }
  const texts = [value]
  try {
    const decoded = decodeURIComponent(value)
    if (decoded !== value) {
      texts.push(...decodedStrings(decoded, depth + 1))
    }
  } catch {
    /* Provider text need not be URI encoded. */
  }
  try {
    const decoded: unknown = JSON.parse(value)
    if (decoded !== value) {
      texts.push(...decodedStrings(decoded, depth + 1))
    }
  } catch {
    /* Ordinary text is not JSON. */
  }
  for (const token of value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    if (
      decoded !== token &&
      !decoded.includes('\uFFFD') &&
      [...decoded].every(
        (char) =>
          ['\n', '\r', '\t'].includes(char) ||
          (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      )
    ) {
      texts.push(...decodedStrings(decoded, depth + 1))
    }
  }
  return texts
}

describe('ACP recording privacy', () => {
  it.each([
    '/Users/u',
    '/home/u',
    '/home/é',
    '/Users/private/project',
    '/home/private/project',
    'C:\\Users\\private\\project'
  ])('detects home paths after nested JSON, URL, base64 and byte encoding: %s', (path) => {
    for (const value of [
      path,
      encodeURIComponent(path),
      Buffer.from(path).toString('base64'),
      [...Buffer.from(path)],
      JSON.stringify({ nested: JSON.stringify(path) })
    ]) {
      expect(decodedStrings(value).some((text) => privateText.test(text))).toBe(true)
    }
  })

  it('contains no personal metadata or home-directory paths in any decoded fixture', async () => {
    const directory = new URL('./fixtures/', import.meta.url)
    const names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
    expect(names.length).toBeGreaterThanOrEqual(6)
    for (const name of names) {
      const content = await readFile(new URL(name, directory), 'utf8')
      for (const [index, line] of content.trim().split('\n').entries()) {
        const value: unknown = JSON.parse(line)
        expect(
          decodedStrings(value).some((text) => privateText.test(text)),
          `${name}:${index + 1}`
        ).toBe(false)
      }
    }
  })
})
