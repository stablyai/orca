import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

export interface HomeResume {
  hostId: string;
  worktreeId: string;
  title: string;
  repo: string;
  paneKey: string;
  executionHost: string;
}

export function readHomeResume(context: common.Context): HomeResume | null {
  try {
    let prefs = preferences.getPreferencesSync(context, { name: 'orca_home_resume' });
    let value = JSON.parse(prefs.getSync('value', 'null') as string) as HomeResume | null;
    if (!value || !/^[a-f0-9]{32}$/.test(value.hostId) || typeof value.worktreeId !== 'string'
      || value.worktreeId.length === 0 || value.worktreeId.length > 4096
      || typeof value.title !== 'string' || typeof value.repo !== 'string'
      || typeof value.paneKey !== 'string' || typeof value.executionHost !== 'string') { return null; }
    return value;
  } catch (e) { return null; }
}

export function saveHomeResume(context: common.Context, value: HomeResume): void {
  if (!/^[a-f0-9]{32}$/.test(value.hostId) || value.worktreeId.length === 0 || value.worktreeId.length > 4096) { return; }
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_home_resume' });
  prefs.putSync('value', JSON.stringify(value)); prefs.flushSync();
}

export function clearHomeResume(context: common.Context, hostId: string): void {
  let held = readHomeResume(context);
  if (!held || held.hostId !== hostId) { return; }
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_home_resume' });
  prefs.putSync('value', 'null'); prefs.flushSync();
}

export function resumeFromLocation(hostId: string, pathname: string, params: Record<string, string>): HomeResume | null {
  let parts = pathname.split('/');
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'h' || parts[3] !== 'session') { return null; }
  try {
    if (decodeURIComponent(parts[2]) !== hostId) { return null; }
    let worktree = decodeURIComponent(parts[4]);
    if (!worktree || worktree === '.' || worktree === '..') { return null; }
    let resume: HomeResume = { hostId: hostId, worktreeId: worktree, title: params['name'] || worktree,
      repo: '', paneKey: params['paneKey'] || '', executionHost: params['executionHost'] || '' };
    return resume;
  } catch (e) { return null; }
}
