// Orca's SSH files for cloud workspaces, all under <userData>/cloud-ssh (0700): per-workspace keys
// (0600), the generated ssh_config and known_hosts, and which workspace owns which alias. Nothing
// here touches ~/.ssh.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const EntrySchema = z.object({
  alias: z.string().regex(/^orca-[a-z0-9-]{1,48}$/),
  /** The workspace's ephemeral VM runtime record; `orca ssh-proxy` resolves it. */
  runtimeId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  sandboxId: z.string().min(1).max(128),
  workspaceName: z.string().max(256).optional(),
  publicKey: z.string().min(1).max(512),
  user: z.string().min(1).max(32).optional(),
  port: z.number().int().optional(),
  hostKey: z.string().max(256).optional(),
  installedAt: z.number().optional(),
  createdAt: z.number()
})
export type CloudSshEntry = z.infer<typeof EntrySchema>

/** A revoked key still in a VM that slept through the revoke; removed when the VM is next up. */
const StaleKeySchema = z.object({
  runtimeId: z.string().min(1).max(128),
  sandboxId: z.string().min(1).max(128),
  publicKey: z.string().min(1).max(512)
})
export type CloudSshStaleKey = z.infer<typeof StaleKeySchema>

const StateSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.unknown()),
  staleKeys: z.array(z.unknown()).default([])
})
export type CloudSshState = { entries: CloudSshEntry[]; staleKeys: CloudSshStaleKey[] }

export type CloudSshPaths = {
  dir: string
  keysDir: string
  stateFile: string
  configFile: string
  knownHostsFile: string
}

export function cloudSshPaths(userDataPath: string): CloudSshPaths {
  const dir = join(userDataPath, 'cloud-ssh')
  return {
    dir,
    keysDir: join(dir, 'keys'),
    stateFile: join(dir, 'state.json'),
    configFile: join(dir, 'config'),
    knownHostsFile: join(dir, 'known_hosts')
  }
}

export function cloudSshKeyFile(paths: CloudSshPaths, alias: string): string {
  return join(paths.keysDir, alias)
}

export async function ensureCloudSshDirs(paths: CloudSshPaths): Promise<void> {
  await mkdir(paths.keysDir, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by umask and skipped for existing dirs; ssh insists on private keys.
  await chmod(paths.dir, 0o700)
  await chmod(paths.keysDir, 0o700)
}

const EMPTY: CloudSshState = { entries: [], staleKeys: [] }

export async function readCloudSshState(paths: CloudSshPaths): Promise<CloudSshState> {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(await readFile(paths.stateFile, 'utf8')))
    if (!parsed.success) {
      return EMPTY
    }
    // Per entry: one unreadable workspace must not drop every other workspace's access.
    return {
      entries: parsed.data.entries.flatMap((entry) => {
        const ok = EntrySchema.safeParse(entry)
        return ok.success ? [ok.data] : []
      }),
      staleKeys: parsed.data.staleKeys.flatMap((stale) => {
        const ok = StaleKeySchema.safeParse(stale)
        return ok.success ? [ok.data] : []
      })
    }
  } catch {
    return EMPTY
  }
}

/** Atomic and private: a torn write never leaves ssh reading half a config or key. */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

export async function writeCloudSshState(
  paths: CloudSshPaths,
  state: CloudSshState
): Promise<void> {
  await writePrivateFile(paths.stateFile, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
}

export async function removeCloudSshKeyFiles(paths: CloudSshPaths, alias: string): Promise<void> {
  const file = cloudSshKeyFile(paths, alias)
  await rm(file, { force: true })
  await rm(`${file}.pub`, { force: true })
}
