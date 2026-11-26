import type {
  DashboardBotAsk,
  DashboardOpenBotItemArgs
} from '../../../shared/agent-status/presentation/dashboard-snapshot'
import { normalizeExecutionHostId } from '../../../shared/execution-host/execution-host'

const MAX_DASHBOARD_BOT_ASKS = 500
const MAX_ID_LENGTH = 4_096
const MAX_TEXT_LENGTH = 2_000

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isHostId(value: unknown): boolean {
  return isBoundedString(value, MAX_ID_LENGTH) && normalizeExecutionHostId(value) !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDashboardBotAsk(value: unknown): value is DashboardBotAsk {
  return (
    isRecord(value) &&
    isHostId(value.botHostId) &&
    isBoundedString(value.botId, MAX_ID_LENGTH) &&
    isBoundedString(value.botName, MAX_TEXT_LENGTH, true) &&
    (value.botAvatar === null || isBoundedString(value.botAvatar, MAX_TEXT_LENGTH, true)) &&
    isBoundedString(value.itemUid, MAX_ID_LENGTH) &&
    isBoundedString(value.title, MAX_TEXT_LENGTH, true) &&
    isBoundedString(value.question, MAX_TEXT_LENGTH, true) &&
    Number.isSafeInteger(value.number) &&
    typeof value.activityAt === 'number' &&
    Number.isFinite(value.activityAt)
  )
}

/** Keeps the valid asks; undefined (older producers) stays undefined, anything else unusable is null. */
export function admitDashboardBotAsks(value: unknown): DashboardBotAsk[] | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_DASHBOARD_BOT_ASKS) {
    return null
  }
  return value.filter(isDashboardBotAsk)
}

export function isDashboardOpenBotItemArgs(value: unknown): value is DashboardOpenBotItemArgs {
  return (
    isRecord(value) &&
    isHostId(value.botHostId) &&
    isBoundedString(value.botId, MAX_ID_LENGTH) &&
    isBoundedString(value.itemUid, MAX_ID_LENGTH)
  )
}
