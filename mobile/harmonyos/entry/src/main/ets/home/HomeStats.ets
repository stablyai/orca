export interface HomeStats { totalAgentsSpawned: number; totalPRsCreated: number; totalAgentTimeMs: number; }

export function readHomeStats(json: string): HomeStats | null {
  try {
    let value = JSON.parse(json) as Record<string, Object>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
    let keys = ['totalAgentsSpawned', 'totalPRsCreated', 'totalAgentTimeMs'];
    let result: Record<string, number> = {}; let answered = false;
    for (let i = 0; i < keys.length; i++) {
      let field = value[keys[i]];
      result[keys[i]] = typeof field === 'number' && Number.isFinite(field) ? field : 0;
      if (typeof field === 'number' && Number.isFinite(field)) { answered = true; }
    }
    return answered ? { totalAgentsSpawned: result['totalAgentsSpawned'], totalPRsCreated: result['totalPRsCreated'],
      totalAgentTimeMs: result['totalAgentTimeMs'] } : null;
  } catch (e) { return null; }
}

export function totalHomeStats(byHost: Record<string, HomeStats>, hostIds: string[]): HomeStats | null {
  let total: HomeStats = { totalAgentsSpawned: 0, totalPRsCreated: 0, totalAgentTimeMs: 0 }; let answered = false;
  for (let id of hostIds) {
    let row = byHost[id]; if (!row) { continue; }
    total.totalAgentsSpawned += row.totalAgentsSpawned; total.totalPRsCreated += row.totalPRsCreated;
    total.totalAgentTimeMs += row.totalAgentTimeMs; answered = true;
  }
  return answered ? total : null;
}
