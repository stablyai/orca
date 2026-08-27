import { join } from 'node:path'
import {
  _getRolloutSessionIndexTitleCacheSizeForTest,
  _hasRolloutSessionIndexTitleCacheEntryForTest,
  _readCachedRolloutSessionIndexTitlesForTest,
  _storeRolloutSessionIndexTitleCacheEntryForTest,
  readRolloutSessionIndexTitle,
  resetRolloutSessionIndexTitleCacheForTests
} from './session-scanner-rollout-title-index'

function codexIndexPath(codexHome: string): string {
  return join(codexHome, 'session_index.jsonl')
}

export const resetCodexSessionIndexTitleCacheForTests = resetRolloutSessionIndexTitleCacheForTests
export const _getCodexSessionIndexTitleCacheSizeForTest =
  _getRolloutSessionIndexTitleCacheSizeForTest
export const _hasCodexSessionIndexTitleCacheEntryForTest = (codexHome: string): boolean =>
  _hasRolloutSessionIndexTitleCacheEntryForTest(codexIndexPath(codexHome))
export const _storeCodexSessionIndexTitleCacheEntryForTest = (
  codexHome: string,
  signature: string,
  titles: Promise<Map<string, string>>
): void =>
  _storeRolloutSessionIndexTitleCacheEntryForTest(codexIndexPath(codexHome), signature, titles)
export const _readCachedCodexSessionIndexTitlesForTest = (
  codexHome: string,
  signature: string
): Promise<Map<string, string> | undefined> =>
  _readCachedRolloutSessionIndexTitlesForTest(codexIndexPath(codexHome), signature)

export async function readCodexSessionIndexTitle(
  sessionFilePath: string,
  codexHome: string | null,
  sessionId: string
): Promise<string | null> {
  return readRolloutSessionIndexTitle({
    sessionFilePath,
    sessionHome: codexHome,
    sessionId
  })
}
