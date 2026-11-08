export interface HomeWorktree {
  worktreeId: string;
  title: string;
  repo: string;
  state: string;
  unread: boolean;
  lastOutputAt: number;
  paneKey: string;
  executionHost: string;
}

function stringField(record: Record<string, Object>, field: string): string {
  let value = record[field];
  return typeof value === 'string' ? value : '';
}

export function homeAttentionRank(state: string): number {
  if (state === 'permission' || state === 'failed') { return 0; }
  if (state === 'done') { return 1; }
  if (state === 'working' || state === 'monitoring') { return 2; }
  return 3;
}

export function isHomeAttention(row: HomeWorktree): boolean {
  return homeAttentionRank(row.state) < 3 && (row.state !== 'done' || row.unread);
}

function dotStatus(row: Record<string, Object>): string {
  let sidebar = stringField(row, 'sidebarStatus');
  if (['permission', 'failed', 'working', 'monitoring', 'unconfirmed', 'interrupted', 'done'].includes(sidebar)) {
    return sidebar;
  }
  if (row['hasHostSidebarActivity'] === false) { return 'inactive'; }
  let state = stringField(row, 'status');
  if (['working', 'active', 'permission', 'done'].includes(state)) { return state; }
  if (row['hasHostSidebarActivity'] === true) { return 'active'; }
  if (state === 'inactive') { return state; }
  let count = row['liveTerminalCount'];
  return typeof count === 'number' && count > 0 ? 'active' : 'inactive';
}

// A full catalog replaces the prior one; removed workspaces must not survive a refresh.
export function readHomeCatalog(json: string): HomeWorktree[] | null {
  try {
    let reply = JSON.parse(json) as Record<string, Object>;
    if (reply === null || typeof reply !== 'object' || !Array.isArray(reply['worktrees'])) { return null; }
    let rows = reply['worktrees'] as Array<Object>;
    let result: HomeWorktree[] = [];
    for (let i = 0; i < rows.length; i++) {
      let value = rows[i];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { return null; }
      let row = value as Record<string, Object>;
      let id = stringField(row, 'worktreeId');
      if (id.length === 0) { return null; }
      if (row['isArchived'] === true) { continue; }
      let repo = stringField(row, 'repo');
      let title = stringField(row, 'displayName') || repo || id;
      let state = dotStatus(row);
      let paneKey = '';
      let agents = row['agents'];
      let newest = -1;
      if (Array.isArray(agents)) {
        let list = agents as Array<Object>;
        for (let j = 0; j < list.length; j++) {
          let item = list[j];
          if (item === null || typeof item !== 'object' || Array.isArray(item)) { continue; }
          let agent = item as Record<string, Object>;
          let agentState = stringField(agent, 'state');
          if (agentState === 'waiting' || agentState === 'blocked') { agentState = 'permission'; }
          if (agentState === 'working' && agent['workingMode'] === 'monitoring') { agentState = 'monitoring'; }
          let updatedAt = agent['updatedAt'];
          let conversation = stringField(agent, 'conversationName').trim();
          if (agentState === state && conversation.length > 0 && typeof updatedAt === 'number'
            && updatedAt > newest && (agent['parentPaneKey'] === null || agent['parentPaneKey'] === undefined)) {
            newest = updatedAt;
            title = conversation;
            paneKey = stringField(agent, 'paneKey');
          }
        }
      }
      let lastOutput = row['lastOutputAt'];
      let host = stringField(row, 'hostId');
      result.push({ worktreeId: id, title: title, repo: repo, state: state,
        unread: row['unread'] === true, lastOutputAt: typeof lastOutput === 'number' ? lastOutput : 0,
        paneKey: paneKey, executionHost: host.startsWith('runtime:') ? host : '' });
    }
    return result;
  } catch (e) { return null; }
}
