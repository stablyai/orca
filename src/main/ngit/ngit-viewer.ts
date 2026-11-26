import { homedir } from 'node:os'
import { z } from 'zod'
import type { NgitViewer } from '../../shared/ngit/ngit-work-item-types'
import { execNgit, NgitCliMissingError, type NgitExec } from './ngit-cli'

const Whoami = z.object({
  accounts: z.array(z.object({ active: z.boolean(), npub: z.string(), name: z.string().nullish() }))
})

/** The identity ngit would sign with here. Reads names and public keys only. */
export async function getNgitViewer(
  cwd: string = homedir(),
  exec: NgitExec = execNgit
): Promise<NgitViewer> {
  try {
    const stdout = await exec(['account', 'whoami', '--json', '--offline'], cwd)
    const { accounts } = Whoami.parse(JSON.parse(stdout))
    const active = accounts.find((account) => account.active)
    return {
      cliInstalled: true,
      account: active ? { npub: active.npub, name: active.name ?? null } : null
    }
  } catch (error) {
    return { cliInstalled: !(error instanceof NgitCliMissingError), account: null }
  }
}
