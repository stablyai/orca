type HostScreenRouteRouter = {
  push(target: string): void
  replace(target: string): void
}

export function navigateFromHostScreenList(args: {
  router: HostScreenRouteRouter
  pathname: string
  target: string
  embedded: boolean
  hostId: string | undefined
}): void {
  if (!args.embedded) {
    args.router.push(args.target)
    return
  }
  if (args.pathname === (args.target.split('?')[0] ?? args.target)) {
    return
  }
  if (args.pathname === `/h/${args.hostId}`) {
    args.router.push(args.target)
    return
  }
  args.router.replace(args.target)
}
