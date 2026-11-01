import { EmptyState, List, ListItem } from 'orca'
import { toggle, type Todo } from './todos'

export function TodoList({ items }: { items: Todo[] }) {
  if (items.length === 0) {
    return <EmptyState icon="check" title="Nothing to do" description="Add a task above." />
  }
  return (
    <List label="Tasks">
      {items.map((todo) => (
        <ListItem
          key={String(todo.id)}
          icon={todo.done ? 'check' : 'stop'}
          title={todo.title}
          description={todo.done ? 'Done' : 'Open'}
          onPress={() => toggle(todo.id)}
        />
      ))}
    </List>
  )
}
