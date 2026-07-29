// Why: macOS 26 backs AppKit objects (windows, NSStatusItem) with scenes, and a scene
// update sent re-entrantly from inside AppKit's own dispatch self-deadlocks the main
// thread in FrontBoardServices; a fresh event-loop turn vacates that callout frame.
export function deferAppKitSceneMutation(mutate: () => void): void {
  setTimeout(mutate, 0)
}
