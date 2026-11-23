import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'

export type AzureDevOpsPrWriteKind = 'comment' | 'vote'

/** A ceiling on what agents can post per local day, whatever loop or prompt drives them. */
export const AZURE_DEVOPS_PR_DAILY_WRITE_LIMITS: Record<AzureDevOpsPrWriteKind, number> = {
  comment: 20,
  vote: 5
}

export type AzureDevOpsPrWriteBudget = { day: string; comment: number; vote: number }

export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** The budget after one more write, or null when that write would pass today's limit. */
export function spendAzureDevOpsPrWrite(
  stored: Partial<AzureDevOpsPrWriteBudget> | null,
  kind: AzureDevOpsPrWriteKind,
  today: string,
  limits: Record<AzureDevOpsPrWriteKind, number> = AZURE_DEVOPS_PR_DAILY_WRITE_LIMITS
): AzureDevOpsPrWriteBudget | null {
  const current: AzureDevOpsPrWriteBudget =
    stored?.day === today
      ? {
          day: today,
          comment: Math.max(0, Number(stored.comment) || 0),
          vote: Math.max(0, Number(stored.vote) || 0)
        }
      : { day: today, comment: 0, vote: 0 }
  if (current[kind] >= limits[kind]) {
    return null
  }
  return { ...current, [kind]: current[kind] + 1 }
}

let queue: Promise<unknown> = Promise.resolve()

function budgetPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'azure-devops', 'pr-write-budget.json')
}

async function readBudget(path: string): Promise<Partial<AzureDevOpsPrWriteBudget> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Reserves one write before it is sent; a failed request still counts, so a retry loop
 * against a flaky host cannot post past the limit.
 */
export function reserveAzureDevOpsPrWrite(kind: AzureDevOpsPrWriteKind): Promise<void> {
  const next = queue.then(async () => {
    const path = budgetPath()
    const spent = spendAzureDevOpsPrWrite(await readBudget(path), kind, localDay(new Date()))
    if (!spent) {
      throw new Error(
        `Daily limit reached: ${AZURE_DEVOPS_PR_DAILY_WRITE_LIMITS[kind]} pull request ${kind}s per day through Orca. Post more in Azure DevOps directly.`
      )
    }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(spent), 'utf8')
    await rename(temporary, path)
  })
  queue = next.catch(() => undefined)
  return next
}
