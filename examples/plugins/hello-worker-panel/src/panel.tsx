// No build step: Orca strips the types, compiles the JSX and resolves `./todos` when it loads.
import {
  atom,
  Badge,
  Button,
  Heading,
  IconButton,
  Input,
  on,
  plugin,
  Progress,
  read,
  Row,
  set,
  Stack,
  Text,
  ui,
  update,
  type PanelContext
} from 'orca'
import { TodoList } from './todo-list'
import { add, clearDone, draft, openCount, percentDone, todos } from './todos'

const themeSwitches = atom(0)
const celebration = atom<string | null>(null)
/** Agent panes working right now, from `agent.status.changed` (the `agent:read` capability). */
const workingAgents = atom<ReadonlySet<string>>(new Set())

async function suggest(): Promise<void> {
  // Starts the plugin's worker if it is not running; typed by src/protocol.ts.
  const { title } = await plugin.request('tasks.suggest', {
    taken: read(todos).map((todo) => todo.title)
  })
  set(draft, title ?? '')
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    on('theme', () => update(themeSwitches, (n) => n + 1)),
    plugin.on('tasks.allDone', ({ count }) => set(celebration, `All ${count} done!`)),
    on('agent.status.changed', ({ paneKey, state }) =>
      update(workingAgents, (panes) => {
        const next = new Set(panes)
        if (state === 'working') {
          next.add(paneKey)
        } else {
          next.delete(paneKey)
        }
        return next
      })
    )
  )
  // Wakes the worker so it sees the list change; the suggestion fills an empty field.
  void suggest().catch(() => undefined)
}

export default function Panel() {
  const open = read(openCount)
  const done = read(celebration)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Tasks</Heading>
        <Row gap="xs">
          {read(workingAgents).size > 0 ? (
            <Badge tone="warning">{read(workingAgents).size} agents working</Badge>
          ) : null}
          <Badge tone={open > 0 ? 'accent' : 'success'}>{open} open</Badge>
        </Row>
      </Row>
      {done ? <Text tone="success">{done}</Text> : null}
      {/* Feature-detect: an older Orca without Progress still renders the rest. */}
      {ui.has('Progress') ? <Progress label="Done" labelHidden value={read(percentDone)} /> : null}
      <Row gap="xs">
        <Input
          label="New task"
          labelHidden
          placeholder="New task"
          value={read(draft)}
          onChange={(value) => set(draft, value)}
          onSubmit={add}
        />
        <IconButton icon="add" label="Add task" onPress={add} disabled={!read(draft).trim()} />
      </Row>
      <TodoList items={read(todos)} />
      <Row justify="between">
        <Button variant="ghost" icon="lightbulb" onPress={() => void suggest()}>
          Suggest
        </Button>
        <Button variant="ghost" onPress={clearDone}>
          Clear done
        </Button>
      </Row>
      <Text muted size="xs">
        Written in TSX with no build step. Theme switches seen: {read(themeSwitches)}.
      </Text>
    </Stack>
  )
}
