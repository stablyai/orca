export function shouldSendSyntheticTitleFrame(args: {
  force: boolean
  windowVisible: boolean
}): boolean {
  return args.force || args.windowVisible
}
