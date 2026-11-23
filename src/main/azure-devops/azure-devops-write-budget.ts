import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'

export type AzureDevOpsWriteKind = 'comment' | 'vote' | 'workItemComment' | 'workItemUpdate'

/** A ceiling on what agents can post per local day, whatever loop or prompt drives them. */
export const AZURE_DEVOPS_DAILY_WRITE_LIMITS: Record<AzureDevOpsWriteKind, number> = {
  comment: 20,
  vote: 5,
  workItemComment: 20,
  workItemUpdate: 20
}

const WRITE_LABELS: Record<AzureDevOpsWriteKind, string> = {
  comment: 'pull request comments',
  vote: 'pull request votes',
  workItemComment: 'work item comments',
  workItemUpdate: 'work item updates'
}

export type AzureDevOpsWriteBudget = { day: string } & Record<AzureDevOpsWriteKind, number>

export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** The budget after one more write, or null when that write would pass today's limit. */
export function spendAzureDevOpsWrite(
  stored: Partial<Record<string, unknown>> | null,
  kind: AzureDevOpsWriteKind,
  today: string,
  limits: Partial<Record<AzureDevOpsWriteKind, number>> = AZURE_DEVOPS_DAILY_WRITE_LIMITS
): AzureDevOpsWriteBudget | null {
  const count = (each: AzureDevOpsWriteKind): number =>
    stored?.day === today ? Math.max(0, Number(stored[each]) || 0) : 0
  const current: AzureDevOpsWriteBudget = {
    day: today,
    comment: count('comment'),
    vote: count('vote'),
    workItemComment: count('workItemComment'),
    workItemUpdate: count('workItemUpdate')
  }
  const limit = limits[kind] ?? AZURE_DEVOPS_DAILY_WRITE_LIMITS[kind]
  if (current[kind] >= limit) {
    return null
  }
  return { ...current, [kind]: current[kind] + 1 }
}

let queue: Promise<unknown> = Promise.resolve()

function budgetPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'azure-devops', 'write-budget.json')
}

async function readBudget(path: string): Promise<Partial<Record<string, unknown>> | null> {
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
export function reserveAzureDevOpsWrite(kind: AzureDevOpsWriteKind): Promise<void> {
  const next = queue.then(async () => {
    const path = budgetPath()
    const spent = spendAzureDevOpsWrite(await readBudget(path), kind, localDay(new Date()))
    if (!spent) {
      throw new Error(
        `Daily limit reached: ${AZURE_DEVOPS_DAILY_WRITE_LIMITS[kind]} ${WRITE_LABELS[kind]} per day through Orca. Make more in Azure DevOps directly.`
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
