import {
  atom,
  Button,
  Checkbox,
  Collapsible,
  Field,
  Input,
  RadioGroup,
  read,
  Row,
  set,
  Slider,
  Stack,
  Switch,
  Text,
  Textarea
} from 'orca'

export const title = atom('gallery.title', '', { persist: 'plugin' })
export const notes = atom('')
export const priority = atom('normal')
export const effort = atom(3)
export const notify = atom(true)
export const agreed = atom(false)
export const submitted = atom<string | null>(null)

export function FormsTab() {
  const titleError = read(title).trim() === '' ? 'Give the task a title' : undefined
  return (
    <Stack gap="md">
      <Field label="Task" description="What needs doing" error={titleError} required>
        <Input
          label="Title"
          labelHidden
          value={read(title)}
          onChange={(value) => set(title, value)}
        />
        <Textarea
          label="Notes"
          rows={3}
          placeholder="Cmd/Ctrl+Enter to save"
          value={read(notes)}
          onChange={(value) => set(notes, value)}
          onSubmit={(value) => set(submitted, `${read(title)}: ${value}`)}
        />
      </Field>
      <RadioGroup
        label="Priority"
        orientation="horizontal"
        value={read(priority)}
        onChange={(value) => set(priority, value)}
        options={[
          { value: 'low', label: 'Low' },
          { value: 'normal', label: 'Normal' },
          { value: 'high', label: 'High', description: 'Pinned to the top' }
        ]}
      />
      <Slider
        label="Effort"
        min={1}
        max={8}
        showValue
        value={read(effort)}
        onChange={(value) => set(effort, value)}
      />
      <Switch label="Notify me" checked={read(notify)} onChange={(value) => set(notify, value)} />
      <Checkbox
        label="I have read the guidelines"
        description="Required before saving"
        checked={read(agreed)}
        onChange={(value) => set(agreed, value)}
      />
      <Collapsible title="Advanced" description="Rarely needed">
        <Text muted>Nothing here yet: a Collapsible keeps rare options out of the way.</Text>
      </Collapsible>
      <Row justify="end">
        <Button
          variant="solid"
          tone="accent"
          disabled={titleError !== undefined || !read(agreed)}
          onPress={() => set(submitted, read(title))}
        >
          Save
        </Button>
      </Row>
      {read(submitted) ? <Text tone="success">Saved {read(submitted)}</Text> : null}
    </Stack>
  )
}
