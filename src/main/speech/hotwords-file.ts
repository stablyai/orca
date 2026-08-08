import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { normalizeSpeechHotwords } from '../../shared/speech-hotwords'

type HotwordsFileState = {
  references: number
  operation: Promise<void>
}

export type SpeechHotwordsFileLease = {
  filePath: string
  release: () => Promise<void>
}

// Why: digest paths preserve warm-worker reuse; leases prevent concurrent starts from deleting a shared file.
const hotwordsFileStates = new Map<string, HotwordsFileState>()

function enqueueFileOperation(
  state: HotwordsFileState,
  operation: () => Promise<void>
): Promise<void> {
  const result = state.operation.then(operation)
  state.operation = result.catch(() => undefined)
  return result
}

async function releaseFileReference(filePath: string, state: HotwordsFileState): Promise<void> {
  state.references = Math.max(0, state.references - 1)
  if (state.references > 0) {
    return
  }

  await enqueueFileOperation(state, async () => {
    if (state.references > 0) {
      return
    }
    await fs.unlink(filePath).catch(() => undefined)
    if (state.references === 0 && hotwordsFileStates.get(filePath) === state) {
      hotwordsFileStates.delete(filePath)
    }
  })
}

export async function acquireSpeechHotwordsFile(
  hotwords: unknown,
  targetDirectory: string
): Promise<SpeechHotwordsFileLease | undefined> {
  const normalizedHotwords = normalizeSpeechHotwords(hotwords)
  if (normalizedHotwords.length === 0) {
    return undefined
  }

  const content = `${normalizedHotwords.map((word) => `${word} :2.0`).join('\n')}\n`
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
  const hotwordsFilePath = path.join(targetDirectory, `speech-hotwords-${digest}.txt`)
  const state = hotwordsFileStates.get(hotwordsFilePath) ?? {
    references: 0,
    operation: Promise.resolve()
  }
  hotwordsFileStates.set(hotwordsFilePath, state)
  state.references += 1

  let releasePromise: Promise<void> | null = null
  const release = (): Promise<void> => {
    releasePromise ??= releaseFileReference(hotwordsFilePath, state)
    return releasePromise
  }

  try {
    await enqueueFileOperation(state, () => fs.writeFile(hotwordsFilePath, content, 'utf-8'))
  } catch (error) {
    await release()
    throw error
  }

  return { filePath: hotwordsFilePath, release }
}
