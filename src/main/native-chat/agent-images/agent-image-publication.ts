import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentImageFitResult } from './agent-image-fit-protocol'

/** The host owns publication so terminating a decoder cannot abandon its staging file. */
export async function publishAgentImage(
  result: AgentImageFitResult,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  if (!result.bytes) {
    return result.path
  }
  const directory = dirname(result.path)
  await mkdir(directory, { recursive: true })
  const staging = join(directory, `${randomUUID()}.part`)
  try {
    await writeFile(staging, result.bytes, { flag: 'wx', signal })
    signal?.throwIfAborted()
    await rename(staging, result.path)
  } finally {
    await rm(staging, { force: true })
  }
  return result.path
}
