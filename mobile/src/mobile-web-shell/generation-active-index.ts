import { z } from 'zod'
import { SHA256_PATTERN } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'

const BuildIdSchema = z.string().regex(SHA256_PATTERN)
const ACTIVE_BUILD_FILE = 'active-build.json'
export const INVALID_ACTIVE_BUILD = 'invalid' as const

export async function readActiveBuild(fs: GenerationFileSystem, hostRoot: string) {
  const text = await fs.readText(joinUri(hostRoot, ACTIVE_BUILD_FILE))
  if (text === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null) {
      return INVALID_ACTIVE_BUILD
    }
    const parsed = BuildIdSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function writeActiveBuild(fs: GenerationFileSystem, hostRoot: string, buildId: string) {
  return fs.writeText(joinUri(hostRoot, ACTIVE_BUILD_FILE), JSON.stringify(buildId))
}

export function invalidateActiveBuild(fs: GenerationFileSystem, hostRoot: string) {
  return fs.writeText(joinUri(hostRoot, ACTIVE_BUILD_FILE), 'null')
}
