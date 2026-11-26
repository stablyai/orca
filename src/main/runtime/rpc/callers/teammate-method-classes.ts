// What a workspace teammate (a share caller on the workspace tier) may call: every RPC method, named
// once in teammate-method-classes.json under one class. A method the table leaves out is refused, and
// a test fails until it is classified, so a new method can't reach a teammate without a decision.
import classes from './teammate-method-classes.json'

/** `scoped`: acts on what its params name, and runs as the owner's call would (a trusted teammate has
 *  the owner's access; only lists are kept to the agent's workspaces).
 *  `filtered`: a list or stream kept to the agent's workspaces (`teammate-workspace-lists.ts`, or its
 *  handler through `teammate-workspace-view.ts`).
 *  `own`: bound to the caller's own connection, uploads, subscriptions or device.
 *  `refused`: the owner's own host, accounts, settings or other workspaces.
 *  (`hostWindow`, beside the classes, is each reachable method's effect on the host's own window:
 *  `bot-share-host-window-fence.ts`.) */
export type TeammateMethodClass = Exclude<keyof typeof classes, 'hostWindow'>

export const TEAMMATE_METHOD_CLASSES: readonly TeammateMethodClass[] = [
  'scoped',
  'filtered',
  'own',
  'refused'
]
const CLASS_BY_METHOD: ReadonlyMap<string, TeammateMethodClass> = new Map(
  TEAMMATE_METHOD_CLASSES.flatMap((kind) =>
    classes[kind].map((name: string) => [name, kind] as const)
  )
)

export function teammateMethodClass(methodName: string): TeammateMethodClass {
  return CLASS_BY_METHOD.get(methodName) ?? 'refused'
}

/** Every classified method, for the census test. */
export const TEAMMATE_METHOD_CLASS_TABLE = classes
