import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { loadHostCatalog } from '../transport/hosts/host-store'

// Which paired host is which cloud workspace's VM, and where its project lives on that VM.

const LINKS_KEY = 'orca:cloud-workspace-hosts:v1'
const LinkSchema = z.object({
  hostId: z.string().optional(),
  pairedAt: z.number().optional(),
  /** From the create response; the VM's checkout of the workspace's repo. */
  projectRoot: z.string().startsWith('/').optional()
})
const LinksSchema = z.record(z.string(), LinkSchema)
type Links = z.infer<typeof LinksSchema>

let mutation: Promise<unknown> = Promise.resolve()

async function readLinks(): Promise<Links> {
  const raw = await AsyncStorage.getItem(LINKS_KEY)
  try {
    const value: unknown = raw ? JSON.parse(raw) : {}
    // Entry by entry: one bad record must not orphan every other VM pairing.
    const links: Links = {}
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        const parsed = LinkSchema.safeParse(entry)
        if (parsed.success) {
          links[key] = parsed.data
        }
      }
    }
    return links
  } catch {
    // Corrupt storage costs one re-pair, never a workspace that can't be opened.
    return {}
  }
}

function updateLinks(change: (links: Links) => void): Promise<void> {
  const run = mutation.then(async () => {
    const links = await readLinks()
    change(links)
    await AsyncStorage.setItem(LINKS_KEY, JSON.stringify(links))
  })
  mutation = run.catch(() => undefined)
  return run
}

export function recordCloudWorkspaceHost(sandboxId: string, hostId: string | null): Promise<void> {
  return updateLinks((links) => {
    const current = links[sandboxId] ?? {}
    links[sandboxId] = hostId
      ? { ...current, hostId, pairedAt: Date.now() }
      : { projectRoot: current.projectRoot }
  })
}

export function recordCloudWorkspaceProjectRoot(
  sandboxId: string,
  projectRoot: string
): Promise<void> {
  if (!projectRoot.startsWith('/')) {
    return Promise.resolve()
  }
  return updateLinks((links) => {
    links[sandboxId] = { ...links[sandboxId], projectRoot }
  })
}

export async function cloudWorkspaceProjectRoot(sandboxId: string): Promise<string | null> {
  return (await readLinks())[sandboxId]?.projectRoot ?? null
}

/** The paired host for a cloud workspace, if this phone still holds a usable credential for it. */
export async function cloudWorkspaceHostId(sandboxId: string): Promise<string | null> {
  const hostId = (await readLinks())[sandboxId]?.hostId
  if (!hostId) {
    return null
  }
  const host = (await loadHostCatalog()).find((entry) => entry.id === hostId)
  if (!host || host.credentialStatus === 'missing') {
    await recordCloudWorkspaceHost(sandboxId, null)
    return null
  }
  return host.id
}

export async function cloudWorkspaceHostIds(): Promise<ReadonlySet<string>> {
  const ids = Object.values(await readLinks()).flatMap((link) => (link.hostId ? [link.hostId] : []))
  return new Set(ids)
}

export async function clearCloudWorkspaceLinks(): Promise<void> {
  await updateLinks((links) => {
    for (const key of Object.keys(links)) {
      delete links[key]
    }
  })
}
