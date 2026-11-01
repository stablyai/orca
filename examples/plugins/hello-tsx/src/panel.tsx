// No build step: Orca strips the types, compiles the JSX and resolves `./todos` when it loads.
import {
  atom,
  Badge,
  Button,
  Heading,
  IconButton,
  Input,
  on,
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

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(on('theme', () => update(themeSwitches, (n) => n + 1)))
}

export default function Panel() {
  const open = read(openCount)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Tasks</Heading>
        <Badge tone={open > 0 ? 'accent' : 'neutral'}>{open} open</Badge>
      </Row>
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
      <Row justify="end">
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
