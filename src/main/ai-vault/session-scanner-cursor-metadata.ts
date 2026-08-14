import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'
import { asRecord, extractString } from './session-scanner-values'

type CursorSessionMetadata = {
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
}

type CursorMetadataAccess = {
  listDirectories(path: string): Promise<readonly string[]>
  readTextFile(path: string): Promise<string | null>
  joinPath(...segments: string[]): string
}

export type CursorSessionMetadataResolver = {
  enrich(
    session: AiVaultSession,
    chatsDir: string,
    platform: NodeJS.Platform
  ): Promise<AiVaultSession>
}

export function createCursorSessionMetadataResolver(
  access: CursorMetadataAccess
): CursorSessionMetadataResolver {
  const metadataPathsByRoot = new Map<string, Promise<Map<string, string>>>()

  return {
    async enrich(session, chatsDir, platform) {
      if (session.agent !== 'cursor') {
        return session
      }
      const paths = await metadataPaths(chatsDir)
      const metadataPath = paths.get(session.sessionId)
      if (!metadataPath) {
        return session
      }
      const content = await access.readTextFile(metadataPath)
      const metadata = content ? parseCursorSessionMetadata(content) : null
      if (!metadata) {
        return session
      }
      const cwd = session.cwd ?? metadata.cwd
      return {
        ...session,
        cwd,
        createdAt: session.createdAt ?? metadata.createdAt,
        updatedAt: session.updatedAt ?? metadata.updatedAt,
        resumeCommand: buildAiVaultResumeCommand({
          agent: 'cursor',
          sessionId: session.sessionId,
          cwd,
          platform
        })
      }
    }
  }

  async function metadataPaths(chatsDir: string): Promise<Map<string, string>> {
    let pending = metadataPathsByRoot.get(chatsDir)
    if (!pending) {
      pending = indexCursorMetadataPaths(chatsDir, access)
      metadataPathsByRoot.set(chatsDir, pending)
    }
    return pending
  }
}

export function createLocalCursorSessionMetadataResolver(): CursorSessionMetadataResolver {
  return createCursorSessionMetadataResolver({
    listDirectories: async (path) => {
      try {
        return (await readdir(path, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
    readTextFile: async (path) => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    },
    joinPath: join
  })
}

export function cursorChatsDirForProjectsDir(projectsDir: string): string {
  return join(dirname(projectsDir), 'chats')
}

async function indexCursorMetadataPaths(
  chatsDir: string,
  access: CursorMetadataAccess
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  for (const workspaceDir of await access.listDirectories(chatsDir)) {
    const workspacePath = access.joinPath(chatsDir, workspaceDir)
    for (const sessionId of await access.listDirectories(workspacePath)) {
      paths.set(sessionId, access.joinPath(workspacePath, sessionId, 'meta.json'))
    }
  }
  return paths
}

function parseCursorSessionMetadata(content: string): CursorSessionMetadata | null {
  try {
    const record = asRecord(JSON.parse(content) as unknown)
    if (!record) {
      return null
    }
    return {
      cwd: extractString(record.cwd),
      createdAt: timestampIso(record.createdAtMs),
      updatedAt: timestampIso(record.updatedAtMs)
    }
  } catch {
    return null
  }
}

function timestampIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null
}
