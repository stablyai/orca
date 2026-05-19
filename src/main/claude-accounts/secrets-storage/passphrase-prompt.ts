import { showPassphrasePrompt } from './passphrase-dialog'

const MAX_UNLOCK_ATTEMPTS = 3

export type PassphraseHolder = {
  get(): string | null
  set(value: string): void
  clear(): void
}

let singleton: PassphraseHolder | null = null

export function createPassphraseHolder(): PassphraseHolder {
  let cached: Buffer | null = null
  return {
    get: () => (cached ? cached.toString('utf8') : null),
    set: (value: string) => {
      // Why: keep passphrase in a Buffer so we can zero it explicitly on clear/quit.
      if (cached) {
        cached.fill(0)
      }
      cached = Buffer.from(value, 'utf8')
    },
    clear: () => {
      if (cached) {
        cached.fill(0)
      }
      cached = null
    }
  }
}

export function getProcessPassphraseHolder(): PassphraseHolder {
  if (!singleton) {
    singleton = createPassphraseHolder()
  }
  return singleton
}

export function resetPassphraseHolderForTest(): void {
  if (singleton) {
    singleton.clear()
  }
  singleton = null
}

export type PromptOptions = {
  mode: 'unlock' | 'create'
  holder: PassphraseHolder
  verifier?: (passphrase: string) => Promise<boolean>
}

async function promptCreate(holder: PassphraseHolder): Promise<string | null> {
  // Why: loop until the two entered values match or the user cancels. The
  // dialog re-renders its own mismatch warning on each iteration.
  for (;;) {
    const raw = await showPassphrasePrompt({ mode: 'create', attempt: 1 })
    if (raw === null) {
      return null
    }
    const [pass, confirm] = raw.split('\n')
    if (pass && pass === confirm) {
      holder.set(pass)
      return pass
    }
  }
}

async function promptUnlock(
  holder: PassphraseHolder,
  verifier?: (passphrase: string) => Promise<boolean>
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt += 1) {
    const raw = await showPassphrasePrompt({ mode: 'unlock', attempt })
    if (raw === null) {
      return null
    }
    const ok = verifier ? await verifier(raw) : true
    if (ok) {
      holder.set(raw)
      return raw
    }
  }
  // Why: 3 wrong attempts → wipe any cached state and disable for this session.
  holder.clear()
  return null
}

export async function promptForPassphrase(options: PromptOptions): Promise<string | null> {
  const cached = options.holder.get()
  if (cached) {
    return cached
  }
  if (options.mode === 'create') {
    return await promptCreate(options.holder)
  }
  return await promptUnlock(options.holder, options.verifier)
}
