export interface HomeUsageWindow { label: string; usedPercent: number; resetsAt: number; }
export interface HomeUsageCard { key: string; provider: string; account: string; status: string; windows: HomeUsageWindow[]; }
export interface HomeAutomation { id: string; name: string; enabled: boolean; nextRunAt: number;
  ownerKind: string; targetId: string; targetGeneration: number; }
export interface HomeAutomationRun { id: string; title: string; status: string; createdAt: number; }

function record(value: Object): Record<string, Object> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Object> : null;
}
function text(value: Object): string { return typeof value === 'string' ? value : ''; }

function readWindows(limits: Record<string, Object> | null): HomeUsageWindow[] {
  let result: HomeUsageWindow[] = [];
  if (!limits) { return result; }
  let fields = ['session', 'weekly', 'monthly', 'fableWeekly'];
  let names = ['会话', '每周', '每月', 'Fable 每周'];
  for (let i = 0; i < fields.length; i++) {
    let window = record(limits[fields[i]]);
    if (!window) { continue; }
    let used = window['usedPercent']; let reset = window['resetsAt'];
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) { continue; }
    result.push({ label: names[i], usedPercent: used, resetsAt: typeof reset === 'number' ? reset : 0 });
  }
  return result;
}

// Read the same ready/snapshot envelope as accounts-snapshot-stream.ts, never turn a refused read into an empty account list.
export function readHomeUsage(json: string): HomeUsageCard[] | null {
  try {
    let envelope = record(JSON.parse(json) as Object);
    if (!envelope) { return null; }
    let event = record(envelope['result']);
    if (!event || (event['type'] !== 'ready' && event['type'] !== 'snapshot')) { return null; }
    let snapshot = record(event['snapshot']);
    if (!snapshot) { return null; }
    let limits = record(snapshot['rateLimits']);
    if (!limits) { return null; }
    let result: HomeUsageCard[] = [];
    let providers = ['claude', 'codex'];
    for (let p = 0; p < providers.length; p++) {
      let provider = providers[p];
      let accounts = record(snapshot[provider]);
      if (!accounts || !Array.isArray(accounts['accounts'])) { return null; }
      let active = text(accounts['activeAccountId']);
      let runtimeIds = record(accounts['activeAccountIdsByRuntime']);
      let target = record(limits[`${provider}Target`]);
      if (provider === 'codex' && runtimeIds && target) {
        if (target['runtime'] === 'host') { active = text(runtimeIds['host']); }
        else if (target['runtime'] === 'wsl') {
          let wsl = record(runtimeIds['wsl']);
          let distro = text(target['wslDistro']);
          active = wsl ? text(wsl[distro]) : '';
        }
      }
      let liveLimits = record(limits[provider]);
      let liveWindows = readWindows(liveLimits);
      if (active.length === 0 && (liveWindows.length > 0 || (liveLimits && liveLimits['status'] === 'ok'))) {
        result.push({ key: `${provider}:system`, provider: provider, account: '系统默认',
          status: liveLimits ? text(liveLimits['status']) : '', windows: liveWindows });
      }
      let list = accounts['accounts'] as Array<Object>;
      let inactiveValue = limits[provider === 'claude' ? 'inactiveClaudeAccounts' : 'inactiveCodexAccounts'];
      let inactive = Array.isArray(inactiveValue) ? inactiveValue as Array<Object> : [];
      for (let a = 0; a < list.length; a++) {
        let account = record(list[a]);
        if (!account) { continue; }
        let id = text(account['id']);
        if (!id) { continue; }
        let held = id === active ? liveLimits : null;
        if (id !== active) {
          for (let k = 0; k < inactive.length; k++) {
            let item = record(inactive[k]);
            if (item && item['accountId'] === id) { held = record(item['rateLimits']); break; }
          }
        }
        result.push({ key: `${provider}:${id}`, provider: provider, account: text(account['email']) || id,
          status: held ? text(held['status']) : 'unavailable', windows: readWindows(held) });
      }
    }
    return result;
  } catch (e) { return null; }
}

export function readHomeAutomations(json: string): HomeAutomation[] | null {
  try {
    let reply = record(JSON.parse(json) as Object);
    if (!reply || !Array.isArray(reply['automations']) || !Array.isArray(reply['items'])) { return null; }
    let result: HomeAutomation[] = [];
    let list = reply['automations'] as Array<Object>;
    let items = reply['items'] as Array<Object>;
    for (let i = 0; i < list.length; i++) {
      let row = record(list[i]);
      if (!row) { continue; }
      let id = text(row['id']);
      let owners = 0;
      let ownerKind = ''; let targetId = ''; let targetGeneration = 0;
      for (let j = 0; j < items.length; j++) {
        let item = record(items[j]);
        if (item && item['automationId'] === id) {
          let selector = record(item['selector']);
          if (!selector) { continue; }
          let kind = text(selector['kind']);
          let generation = selector['targetGeneration'];
          let target = text(selector['targetId']);
          if (kind !== 'self' && kind !== 'orphan' && !(kind === 'ssh' && target
            && typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0)) { continue; }
          owners++; ownerKind = kind; targetId = target;
          targetGeneration = typeof generation === 'number' ? generation : 0;
        }
      }
      let next = row['nextRunAt'];
      if (id && owners === 1 && typeof row['enabled'] === 'boolean') {
        result.push({ id: id, name: text(row['name']), enabled: row['enabled'] as boolean,
          nextRunAt: typeof next === 'number' ? next : 0, ownerKind: ownerKind,
          targetId: targetId, targetGeneration: targetGeneration });
      }
    }
    return result;
  } catch (e) { return null; }
}

interface AutomationSelfSelector { kind: string; }
interface AutomationSshSelector { kind: string; targetId: string; targetGeneration: number; }
interface AutomationExpectedOwner { selector: AutomationSelfSelector | AutomationSshSelector; }
interface AutomationEnabledUpdate { enabled: boolean; }
interface AutomationToggleParams { id: string; updates: AutomationEnabledUpdate; expectedOwner: AutomationExpectedOwner; }
export function homeAutomationToggleParams(row: HomeAutomation, enabled: boolean): string {
  let selector: AutomationSelfSelector | AutomationSshSelector = { kind: row.ownerKind };
  if (row.ownerKind === 'ssh') {
    selector = { kind: 'ssh', targetId: row.targetId, targetGeneration: row.targetGeneration };
  }
  let params: AutomationToggleParams = { id: row.id, updates: { enabled: enabled }, expectedOwner: { selector: selector } };
  return JSON.stringify(params);
}

export function readHomeAutomationRuns(json: string): HomeAutomationRun[] | null {
  try {
    let reply = record(JSON.parse(json) as Object);
    if (!reply || !Array.isArray(reply['runs'])) { return null; }
    let result: HomeAutomationRun[] = [];
    let list = reply['runs'] as Array<Object>;
    for (let i = 0; i < list.length && result.length < 5; i++) {
      let run = record(list[i]);
      if (!run) { continue; }
      let id = text(run['id']); let createdAt = run['createdAt'];
      if (id && typeof createdAt === 'number') {
        result.push({ id: id, title: text(run['title']), status: text(run['status']), createdAt: createdAt });
      }
    }
    return result;
  } catch (e) { return null; }
}
