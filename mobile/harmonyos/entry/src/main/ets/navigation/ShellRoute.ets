import bundleCompat from '../vendor/bundle-compat.js';

export interface ShellRoute {
  hostId: string;
  pathname: string;
  params: Record<string, string>;
}

const SHELL_QUERY_PARAMS = ['paneKey', 'executionHost', 'name', 'created', 'warning', 'new', 'open'];

export function desktopPath(hostId: string): string { return `/h/${encodeURIComponent(hostId)}`; }

export function isDesktopSession(route: ShellRoute): boolean {
  let prefix = `${desktopPath(route.hostId)}/session/`;
  if (!route.pathname.startsWith(prefix)) { return false; }
  let worktree = route.pathname.substring(prefix.length);
  return worktree.length > 0 && !worktree.includes('/');
}

export function sessionOpenParam(route: ShellRoute, pageVersion: number): string {
  if (pageVersion < bundleCompat.MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS || !isDesktopSession(route)) { return ''; }
  let search = Object.keys(route.params).map((key: string): string =>
    `${encodeURIComponent(key)}=${encodeURIComponent(route.params[key])}`).join('&');
  let href = search ? `${route.pathname}?${search}` : route.pathname;
  return href.length <= 1024 ? href : '';
}

export function readShellRoute(values: Record<string, string>): ShellRoute {
  let hostId = values['hostId'] ?? '';
  let pathname = values['route'] || desktopPath(hostId);
  let params: Record<string, string> = {};
  SHELL_QUERY_PARAMS.forEach((key: string): void => {
    if (typeof values[key] === 'string' && values[key]) { params[key] = values[key]; }
  });
  return { hostId: hostId, pathname: pathname, params: params };
}

export function shellRouterParams(route: ShellRoute, hostListFirst: boolean = false): Record<string, string> {
  let values: Record<string, string> = {};
  SHELL_QUERY_PARAMS.forEach((key: string): void => {
    if (route.params[key]) { values[key] = route.params[key]; }
  });
  values['hostId'] = route.hostId;
  values['route'] = route.pathname;
  if (hostListFirst && isDesktopSession(route)) { values['hostListFirst'] = '1'; }
  return values;
}
