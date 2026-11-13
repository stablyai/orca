import { HomeAgentEntry } from './AgentListModel';

export interface HomeWorktree {
  active: boolean;
  agents: HomeAgentEntry[];
}

interface CatalogWorkspace {
  row: Record<string, Object>;
  id: string;
  owner: string;
  identity: string;
  ambiguous: boolean;
}

interface WorkspaceCopies { owner: string; identity: string; ambiguous: boolean; }

const AGENT_TEXT_FIELDS: string[] = ['conversationName', 'displayName', 'taskTitle', 'prompt',
  'agentType', 'lastAssistantMessage', 'toolName', 'toolInput'];
const AGENT_STATUS: string[] = ['working', 'monitoring', 'blocked', 'waiting', 'interrupted', 'failed',
  'done', 'idle', 'unverifiable', 'unconfirmed', 'permission'];
const UNRESOLVED_OWNER_HOST_ID: string = 'runtime:unresolved-owner';

function stringField(record: Record<string, Object>, field: string): string {
  let value = record[field];
  return typeof value === 'string' ? value : '';
}

function executionHostId(value: string): string {
  let host = value.trim();
  if (host === 'local') { return host; }
  if (!host.startsWith('ssh:') && !host.startsWith('runtime:')) { return ''; }
  let suffix = host.substring(host.indexOf(':') + 1);
  if (!suffix || suffix.includes('|')) { return ''; }
  try { return decodeURIComponent(suffix) ? host : ''; }
  catch (e) { return ''; }
}

function readWorkspace(row: Record<string, Object>, id: string): CatalogWorkspace {
  let host = executionHostId(stringField(row, 'hostId'));
  let owner = host;
  let identity = '';
  let ambiguous = row['hostId'] !== undefined && row['hostId'] !== null && !host;
  let rawIdentity = row['identity'];
  if (rawIdentity !== undefined && rawIdentity !== null && typeof rawIdentity === 'object' && !Array.isArray(rawIdentity)) {
    let record = rawIdentity as Record<string, Object>;
    let identityHost = executionHostId(stringField(record, 'executionHostId'));
    let instance = stringField(record, 'instanceId');
    let key = stringField(record, 'key');
    // Server catalogs stamp the outer runtime host and retain the server-relative checkout identity.
    let relative = host.startsWith('runtime:') && !identityHost.startsWith('runtime:');
    if (host && identityHost && host !== identityHost && !relative) { ambiguous = true; }
    if (identityHost && instance && key === `wt2:${encodeURIComponent(identityHost)}:${encodeURIComponent(instance)}`) {
      identity = key;
      if (!owner) { owner = identityHost; }
    }
  }
  return { row: row, id: id, owner: owner, identity: identity, ambiguous: ambiguous || owner === UNRESOLVED_OWNER_HOST_ID };
}

function readAgent(value: Object): Record<string, Object> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return null; }
  let agent = value as Record<string, Object>;
  if (!stringField(agent, 'paneKey') || AGENT_TEXT_FIELDS.some((field: string): boolean =>
    agent[field] !== undefined && agent[field] !== null && typeof agent[field] !== 'string')) { return null; }
  let verdict = agent['activity'] as Record<string, Object> | undefined;
  if (verdict && verdict['listed'] !== false &&
    (verdict['listed'] !== true || typeof verdict['title'] !== 'string' || !AGENT_STATUS.includes(stringField(verdict, 'status')) ||
      typeof verdict['unread'] !== 'boolean' || typeof verdict['clearable'] !== 'boolean' ||
      typeof verdict['sortAt'] !== 'number' || !Number.isFinite(verdict['sortAt']))) { return null; }
  if (typeof agent['prompt'] !== 'string') { agent['prompt'] = ''; }

  if (typeof agent['stateStartedAt'] !== 'number') {
    let updatedAt = agent['updatedAt'];
    agent['stateStartedAt'] = typeof updatedAt === 'number' ? updatedAt : 0;
  }
  return agent;
}

function isWorktreeActive(row: Record<string, Object>): boolean {
  let activity = row['hasHostSidebarActivity'];
  if (typeof activity === 'boolean') { return activity; }
  let state = stringField(row, 'status');
  let count = row['liveTerminalCount'];
  return row['unread'] === true || (state ? state !== 'inactive' : typeof count === 'number' && count > 0);
}

// A full catalog replaces the prior one; removed workspaces must not survive a refresh.
export function readHomeCatalog(json: string): HomeWorktree[] | null {
  try {
    let reply = JSON.parse(json) as Record<string, Object>;
    if (reply === null || typeof reply !== 'object' || !Array.isArray(reply['worktrees'])) { return null; }
    let rows = reply['worktrees'] as Array<Object>;
    let workspaces: CatalogWorkspace[] = [];
    let copies = new Map<string, WorkspaceCopies>();
    for (let i = 0; i < rows.length; i++) {
      let value = rows[i];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { return null; }
      let row = value as Record<string, Object>;
      let id = stringField(row, 'worktreeId');
      if (id.length === 0) { return null; }
      let workspace = readWorkspace(row, id);
      workspaces.push(workspace);
      let held = copies.get(id);
      if (held) {
        held.ambiguous = held.ambiguous || workspace.ambiguous || held.owner !== workspace.owner
          || (!!held.identity && !!workspace.identity && held.identity !== workspace.identity);
        if (!held.identity) { held.identity = workspace.identity; }
      } else {
        copies.set(id, { owner: workspace.owner, identity: workspace.identity, ambiguous: workspace.ambiguous });
      }
    }
    let result: HomeWorktree[] = [];
    for (let i = 0; i < workspaces.length; i++) {
      let workspace = workspaces[i];
      let row = workspace.row;
      let id = workspace.id;
      if (row['isArchived'] === true) { continue; }
      let repo = stringField(row, 'repo');
      let repoId = stringField(row, 'repoId');
      let workspaceName = stringField(row, 'displayName') || repo || id;
      let branch = stringField(row, 'branch');
      let executionHost = workspace.owner.startsWith('runtime:') && workspace.owner !== UNRESOLVED_OWNER_HOST_ID
        ? workspace.owner : '';
      let ambiguous = copies.get(id)?.ambiguous === true;
      let agents = row['agents'];
      let entries: HomeAgentEntry[] = [];
      if (Array.isArray(agents)) {
        let list = agents as Array<Object>;
        list.forEach((item: Object): void => {
          let agent = readAgent(item);
          if (agent) {
            let entry: HomeAgentEntry = { worktreeId: id, workspaceName: workspaceName, repo: repo, branch: branch,
              executionHost: executionHost, agent: agent };
            if (repoId) { entry.repoId = repoId; }
            if (workspace.owner) { entry.executionHostId = workspace.owner; }
            if (workspace.identity) { entry.workspaceIdentityKey = workspace.identity; }
            if (ambiguous) { entry.ambiguousWorkspace = true; }
            entries.push(entry);
          }
        });
      }
      result.push({ active: isWorktreeActive(row), agents: entries });
    }
    return result;
  } catch (e) { return null; }
}
