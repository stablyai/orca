// Hooks of bots on agents the previous release can't read, kept out of the host ledger file. That
// release reads only the ledger file, finds no such bot and deletes its hook in the cloud, so after a
// rollback the hook's URL would be gone for good.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import { isMissingFileError } from '../runtime/rpc/server/pairing/device-registry-corruption'

const NEWER_AGENT_HOOKS_FILE = 'webhook-host-newer-agents.json'

type FiledHook = { hookId: string; botId: string }

export class NewerAgentHooks<H extends FiledHook> {
  // The file's hooks as last read or written; text is null while the ledger file may still hold some.
  private written: { text: string | null; ids: ReadonlySet<string> } | null = null
  // The ledger file as last written, so a change to these hooks alone doesn't rewrite it.
  private ledgerText: string | null = null

  constructor(
    private readonly userDataPath: string,
    private readonly botIds: () => ReadonlySet<string>,
    private readonly hookSchema: z.ZodType<H>
  ) {}

  private get path(): string {
    return join(this.userDataPath, NEWER_AGENT_HOOKS_FILE)
  }

  /**
   * The ledger file's hooks, then this file's it lacks: a build that reads only the ledger file may
   * have written there since, so its copy is the newer one.
   */
  load(account: string, ledgerHooks: H[]): H[] {
    const stored = this.read(account)
    const botIds = this.botIds()
    const misfiled = ledgerHooks.some((hook) => botIds.has(hook.botId))
    const filed = snapshotOf(stored)
    this.written = misfiled ? { ...filed, text: null } : filed
    const listed = new Set(ledgerHooks.map((hook) => hook.hookId))
    return [...ledgerHooks, ...stored.filter((hook) => !listed.has(hook.hookId))]
  }

  private read(account: string): H[] {
    try {
      const parsed = z
        .object({ account: z.string(), hooks: z.array(this.hookSchema) })
        .safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      return parsed.success && parsed.data.account === account ? parsed.data.hooks : []
    } catch (error) {
      if (!isMissingFileError(error)) {
        console.warn(`[webhooks] ${NEWER_AGENT_HOOKS_FILE} was unreadable; starting a new one`)
      }
      return []
    }
  }

  /** A bot changed agents since the last write, so its hooks belong in the other file. */
  unfiled(hooks: readonly H[]): boolean {
    const botIds = this.botIds()
    return JSON.stringify(hooks.filter((hook) => botIds.has(hook.botId))) !== this.written?.text
  }

  /**
   * Writes the ledger file without these hooks, and this file when they changed. A hook moving
   * between the two lands in its new file first, so a crash between the writes leaves it in both.
   */
  save(
    ledgerPath: string,
    ledger: { account: string; hooks: readonly H[] },
    durable: boolean
  ): void {
    const botIds = this.botIds()
    const newer = ledger.hooks.filter((hook) => botIds.has(hook.botId))
    const rest = ledger.hooks.filter((hook) => !botIds.has(hook.botId))
    const next = snapshotOf(newer)
    const saveLedger = () => {
      const text = JSON.stringify({ ...ledger, hooks: rest }, null, 2)
      if (text !== this.ledgerText) {
        writeSecureFile(ledgerPath, text, { durable })
        this.ledgerText = text
      }
    }
    if (next.text === this.written?.text) {
      saveLedger()
      return
    }
    const saveNewer = () => {
      const text = JSON.stringify({ account: ledger.account, hooks: newer }, null, 2)
      writeSecureFile(this.path, text, { durable })
      this.written = next
    }
    if (rest.some((hook) => this.written?.ids.has(hook.hookId))) {
      saveLedger()
      saveNewer()
    } else {
      saveNewer()
      saveLedger()
    }
  }
}

function snapshotOf(hooks: readonly FiledHook[]): { text: string; ids: ReadonlySet<string> } {
  return { text: JSON.stringify(hooks), ids: new Set(hooks.map((hook) => hook.hookId)) }
}
