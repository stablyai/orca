import { HomeAgentEntry } from './AgentListModel';

export interface HomeWorktree {
  state: string;
  agents: HomeAgentEntry[];
}

const AGENT_TEXT_FIELDS: string[] = ['conversationName', 'displayName', 'taskTitle', 'prompt',
  'agentType', 'lastAssistantMessage', 'toolName', 'toolInput'];
const AGENT_STATUS: string[] = ['working', 'monitoring', 'blocked', 'waiting', 'interrupted', 'failed',
  'done', 'idle', 'unverifiable', 'unconfirmed', 'permission'];

function stringField(record: Record<string, Object>, field: string): string {
  let value = record[field];
  return typeof value === 'string' ? value : '';
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
      let workspaceName = stringField(row, 'displayName') || repo || id;
      let branch = stringField(row, 'branch');
      let host = stringField(row, 'hostId');
      let executionHost = host.startsWith('runtime:') ? host : '';
      let agents = row['agents'];
      let entries: HomeAgentEntry[] = [];
      if (Array.isArray(agents)) {
        let list = agents as Array<Object>;
        list.forEach((item: Object): void => {
          let agent = readAgent(item);
          if (agent) {
            entries.push({ worktreeId: id, workspaceName: workspaceName, repo: repo, branch: branch,
              executionHost: executionHost, agent: agent });
          }
        });
      }
      result.push({ state: dotStatus(row), agents: entries });
    }
    return result;
  } catch (e) { return null; }
}
