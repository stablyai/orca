import upstream from '../vendor/agent-list.js';

export interface HomeAgentEntry {
  worktreeId: string;
  workspaceName: string;
  repo: string;
  branch: string;
  executionHost: string;
  agent: Record<string, Object>;
}

export interface AgentDesktop {
  id: string;
  name: string;
  connection: string;
  catalog: HomeAgentEntry[] | null;
  live: boolean;
  loading: boolean;
  seenAt: number;
}

export interface AgentListView {
  groupBy: string;
  showWorkers: boolean;
  unreadOnly: boolean;
}

export const AGENT_GROUPS: string[] = ['status', 'workspace', 'project', 'agent', 'desktop'];
export const DEFAULT_AGENT_VIEW: AgentListView = { groupBy: 'status', showWorkers: true, unreadOnly: false };

export interface AgentListRow {
  key: string;
  hostId: string;
  entry: HomeAgentEntry;
  title: string;
  dotState: string;
  timeAt: number;
  stale: boolean;
  offline: boolean;
  unread?: boolean;
  clearable: boolean;
  depth: number;
  workers: AgentListRow[];
}

export interface AgentLastSeen { offline: boolean; at?: number; }
export interface AgentListSection {
  key: string;
  kind: string;
  title?: string;
  hostId?: string;
  rows: AgentListRow[];
  idleRows?: AgentListRow[];
  lastSeen?: AgentLastSeen;
  footer: string;
  nameDesktop: boolean;
}
export interface AgentListResult { sections: AgentListSection[]; anyLive: boolean; }
export interface AgentDesktopSummary { hostId: string; agents: number; needsYou: number; offline: boolean; }
interface AgentDesktopWorktreeInfo {
  agents?: HomeAgentEntry[];
  lastSeenAgents?: HomeAgentEntry[];
  catalogUnavailable: boolean;
  countsProvenAt?: number;
}
interface AgentListInput {
  hosts: AgentDesktop[];
  hostStates: Record<string, string>;
  worktreeInfo: Record<string, AgentDesktopWorktreeInfo>;
  now: number;
}
interface AgentListOptions { view: AgentListView; hostFilter: string | null; query: string; }

const model: ESObject = upstream;

function toInput(hosts: AgentDesktop[]): AgentListInput {
  let states: Record<string, string> = {};
  let info: Record<string, AgentDesktopWorktreeInfo> = {};
  hosts.forEach((host: AgentDesktop): void => {
    states[host.id] = host.connection;
    info[host.id] = {
      agents: host.live ? host.catalog ?? undefined : undefined,
      lastSeenAgents: host.live ? undefined : host.catalog ?? undefined,
      catalogUnavailable: !host.live,
      countsProvenAt: host.seenAt > 0 ? host.seenAt : undefined
    };
  });
  return { hosts: hosts, hostStates: states, worktreeInfo: info, now: Date.now() };
}

export function buildAgentList(hosts: AgentDesktop[], view: AgentListView, hostId: string, query: string): AgentListResult {
  let options: AgentListOptions = { view: view, hostFilter: hostId || null, query: query };
  return model.buildAgentList(toInput(hosts), options) as AgentListResult;
}

export function agentsNeedingYou(hosts: AgentDesktop[]): AgentListRow[] {
  return model.selectAgentsNeedingYou(toInput(hosts)) as AgentListRow[];
}

export function summarizeAgentDesktops(hosts: AgentDesktop[]): AgentDesktopSummary[] {
  return model.summarizeAgentListHosts(toInput(hosts)) as AgentDesktopSummary[];
}

export function listedAgents(sections: AgentListSection[]): AgentListRow[] {
  return model.agentListRowsIn(sections) as AgentListRow[];
}

export function agentPreview(row: AgentListRow): string {
  return model.agentListPreview(row.entry.agent, row.stale ? null : model.agentStatusGroup(row.dotState), row.title) as string;
}

export function agentKind(row: AgentListRow): string {
  return model.formatAgentTypeLabel(row.entry.agent['agentType']) as string;
}

export function readAgentView(raw: string): AgentListView {
  try {
    let saved: ESObject = JSON.parse(raw);
    if (saved && typeof saved === 'object') {
      return {
        groupBy: AGENT_GROUPS.includes(saved['groupBy']) ? saved['groupBy'] : 'status',
        showWorkers: saved['showWorkers'] !== false,
        unreadOnly: saved['unreadOnly'] === true
      };
    }
  } catch (e) {}
  return DEFAULT_AGENT_VIEW;
}
