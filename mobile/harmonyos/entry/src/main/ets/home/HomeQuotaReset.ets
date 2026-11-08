import { util } from '@kit.ArkTS';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';

export interface HomeQuotaTarget { runtime: string; wslDistro: string | null; }
export interface HomeQuotaScope { target: HomeQuotaTarget; accountId: string; accountRevision: number; offerRevision: string; }
export interface HomeQuotaOffer { scope: HomeQuotaScope; accountLabel: string; availableCount: number; nextExpiresAt: number | null; }
export interface HomeQuotaResult { outcome: string; snapshot: string; }

function snapshotFrom(value: ESObject): ESObject {
  if (value && value['result'] && value['result']['snapshot']) { return value['result']['snapshot']; }
  return value;
}

function activeAccount(snapshot: ESObject): string | null {
  let target: ESObject = snapshot['rateLimits']?.['codexTarget'];
  let selection: ESObject = snapshot['codex']?.['activeAccountIdsByRuntime'];
  if (!target || !selection) { return null; }
  if (target['runtime'] === 'host' && target['wslDistro'] === null) { return selection['host'] ?? null; }
  let distro: ESObject = target['wslDistro'];
  return target['runtime'] === 'wsl' && typeof distro === 'string' && distro.trim()
    ? selection['wsl']?.[distro.trim()] ?? null : null;
}

function windowRevision(value: ESObject): ESObject {
  if (!value) { return null; }
  return [value['usedPercent'], value['windowMinutes'], value['resetsAt']];
}

// CAS revision and account/runtime checks match shared/codex-reset-credit-scope.ts.
export function readHomeQuotaOffer(json: string): HomeQuotaOffer | null {
  try {
    let snapshot: ESObject = snapshotFrom(JSON.parse(json));
    let active = activeAccount(snapshot);
    let target: ESObject = snapshot['rateLimits']?.['codexTarget'];
    let limits: ESObject = snapshot['rateLimits']?.['codex'];
    let accounts: ESObject = snapshot['codex']?.['accounts'];
    let credits: ESObject = limits?.['rateLimitResetCredits'];
    if (!active || !target || !limits || limits['provider'] !== 'codex' || !Array.isArray(accounts)
      || !credits || !Number.isInteger(credits['availableCount']) || credits['availableCount'] < 1) { return null; }
    let account: ESObject = null;
    for (let i = 0; i < accounts.length; i++) { if (accounts[i]['id'] === active) { account = accounts[i]; break; } }
    if (!account || active.trim().length === 0 || active.length > 512
      || !Number.isSafeInteger(account['updatedAt']) || account['updatedAt'] < 0
      || !Number.isSafeInteger(limits['updatedAt']) || limits['updatedAt'] < 0) { return null; }
    let runtime: string = target['runtime'];
    let distro: string | null = null;
    let accountRuntime: string = account['managedHomeRuntime'] ?? 'host';
    if (runtime === 'host') {
      if (target['wslDistro'] !== null || accountRuntime !== 'host') { return null; }
    } else if (runtime === 'wsl') {
      if (typeof target['wslDistro'] !== 'string' || typeof account['wslDistro'] !== 'string') { return null; }
      distro = target['wslDistro'].trim();
      if (!distro || distro.length > 255 || accountRuntime !== 'wsl' || account['wslDistro'].trim() !== distro) { return null; }
    } else { return null; }
    let rows: string[] = [];
    let rawCredits: ESObject = credits['credits'] ?? [];
    if (!Array.isArray(rawCredits)) { return null; }
    for (let i = 0; i < rawCredits.length; i++) {
      let credit: ESObject = rawCredits[i];
      if (!credit || typeof credit !== 'object') { return null; }
      let tuple: ESObject = [credit['status'], credit['expiresAt'], credit['grantedAt']];
      rows.push(JSON.stringify(tuple));
    }
    rows.sort();
    let creditRows: ESObject[] = [];
    for (let row of rows) { creditRows.push(JSON.parse(row)); }
    let revisionValues: ESObject = [credits['availableCount'], credits['totalEarnedCount'] ?? null,
      credits['nextExpiresAt'] ?? null, creditRows, windowRevision(limits['session']),
      windowRevision(limits['weekly']), limits['updatedAt']];
    let revision = `v1:${JSON.stringify(revisionValues)}`;
    if (revision.length > 4096) { return null; }
    let quotaTarget: HomeQuotaTarget = { runtime: runtime, wslDistro: distro };
    let scope: HomeQuotaScope = { target: quotaTarget, accountId: active, accountRevision: account['updatedAt'], offerRevision: revision };
    return { scope: scope, accountLabel: typeof account['email'] === 'string' ? account['email'] : active,
      availableCount: credits['availableCount'], nextExpiresAt: typeof credits['nextExpiresAt'] === 'number' ? credits['nextExpiresAt'] : null };
  } catch (e) { return null; }
}

function sameAccountScope(value: ESObject, scope: HomeQuotaScope): boolean {
  return value && value['accountId'] === scope.accountId && value['accountRevision'] === scope.accountRevision
    && value['target']?.['runtime'] === scope.target.runtime && value['target']?.['wslDistro'] === scope.target.wslDistro;
}

export async function consumeHomeQuotaReset(client: SpikeRpcClient, scope: HomeQuotaScope): Promise<HomeQuotaResult> {
  let params: ESObject = { expectedScope: scope, idempotencyKey: util.generateRandomUUID(true) };
  let response = await client.request('accounts.consumeCodexResetCredit', JSON.stringify(params), 90000);
  if (!(response instanceof RpcSuccess)) { throw new Error(response.errorMessage); }
  let result: ESObject = JSON.parse(response.result);
  if (!sameAccountScope(result['scope'], scope) || typeof result['scope']['offerRevision'] !== 'string'
    || !result['scope']['offerRevision'].startsWith('v1:') || result['scope']['offerRevision'].length > 4096) {
    throw new Error('Invalid reset account scope');
  }
  let snapshot: ESObject = result['snapshot'];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot['codex']?.['accounts'])
    || !snapshot['rateLimits']?.['codexTarget']) { throw new Error('Invalid reset snapshot'); }
  if (result['status'] === 'rejectedBeforeProvider') {
    if (result['retryDisposition'] !== 'discardAttempt' || result['outcome'] !== undefined
      || !['targetChanged', 'accountChanged', 'accountRevisionChanged', 'accountRuntimeChanged', 'offerUnavailable', 'offerChanged'].includes(result['reason'])) {
      throw new Error('Invalid reset refusal');
    }
    return { outcome: 'detailsChanged', snapshot: JSON.stringify(snapshot) };
  }
  if (result['status'] !== undefined || !['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(result['outcome'])
    || activeAccount(snapshot) !== scope.accountId || snapshot['rateLimits']['codexTarget']['runtime'] !== scope.target.runtime
    || snapshot['rateLimits']['codexTarget']['wslDistro'] !== scope.target.wslDistro) { throw new Error('Invalid reset result'); }
  let account: ESObject = null;
  let accounts: ESObject = snapshot['codex']['accounts'];
  for (let i = 0; i < accounts.length; i++) { if (accounts[i]['id'] === scope.accountId) { account = accounts[i]; break; } }
  if (!account || account['updatedAt'] !== scope.accountRevision) { throw new Error('Reset account changed'); }
  return { outcome: result['outcome'], snapshot: JSON.stringify(snapshot) };
}
