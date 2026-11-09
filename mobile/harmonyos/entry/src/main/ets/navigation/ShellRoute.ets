export interface ShellRoute {
  hostId: string;
  pathname: string;
  params: Record<string, string>;
}

export function readShellRoute(values: Record<string, string>): ShellRoute {
  let hostId = values['hostId'] ?? '';
  let pathname = values['route'] || `/h/${encodeURIComponent(hostId)}`;
  let params: Record<string, string> = {};
  ['paneKey', 'executionHost', 'name', 'created', 'warning', 'new', 'open'].forEach((key: string): void => {
    if (typeof values[key] === 'string' && values[key]) { params[key] = values[key]; }
  });
  return { hostId: hostId, pathname: pathname, params: params };
}

export function shellRouterParams(route: ShellRoute): Record<string, string> {
  let values: Record<string, string> = {};
  Object.keys(route.params).forEach((key: string): void => { values[key] = route.params[key]; });
  values['hostId'] = route.hostId;
  values['route'] = route.pathname;
  return values;
}
