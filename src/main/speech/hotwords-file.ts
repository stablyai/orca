import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { normalizeSpeechHotwords } from '../../shared/speech-hotwords'

export async function writeSpeechHotwordsFile(
  hotwords: unknown,
  targetDirectory: string
): Promise<string | undefined> {
  const normalizedHotwords = normalizeSpeechHotwords(hotwords)
  if (normalizedHotwords.length === 0) {
    return undefined
  }

  const content = `${normalizedHotwords.map((word) => `${word} :2.0`).join('\n')}\n`
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const hotwordsFilePath = path.join(targetDirectory, `speech-hotwords-${digest}.txt`)
  await fs.writeFile(hotwordsFilePath, content, 'utf-8')
  return hotwordsFilePath
}

export function removeSpeechHotwordsFile(path: string | undefined): void {
  if (path) {
    fs.unlink(path).catch(() => {})
  }
}
