import {
  Callout,
  Card,
  CodeView,
  Grid,
  IconButton,
  Image,
  KeyValue,
  Markdown,
  Skeleton,
  Stack,
  Text,
  Toolbar,
  Button,
  host,
  RelativeTime,
  ui
} from 'orca'

// When this panel module loaded: RelativeTime keeps "…ago" current with no timer of our own.
const loadedAt = Date.now()

const README = `## Components Gallery

Everything here is drawn by Orca from plain data. Links such as
[the components guide](https://github.com/stablyai/orca) open in your browser.

- **Tables** page and sort
- **Trees** load children lazily
`

const SAMPLE = `export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`

export function ContentTab() {
  return (
    <Stack gap="md">
      <Toolbar label="Gallery actions">
        <Button
          icon="bell"
          tooltip="Shows a desktop notification"
          onPress={() => host.call('notifications.show', { title: 'Hello from the gallery' })}
        >
          Notify
        </Button>
        <IconButton icon="refresh" label="Refresh" />
        <IconButton icon="settings" label="Settings" tooltip="Gallery settings" />
      </Toolbar>
      <Callout tone="accent" title="Catalog 2">
        <Text>These components need Orca 1.4.247 or newer (ui.catalog {ui.catalog}).</Text>
        <Text muted size="xs">
          Opened <RelativeTime at={loadedAt} format="long" />
        </Text>
      </Callout>
      <Grid minItemWidth="sm" gap="sm">
        <Card title="Logo">
          <Image src="assets/logo.png" alt="Gallery logo" size="sm" rounded />
        </Card>
        <Card title="Repository">
          <KeyValue
            items={[
              { label: 'Branch', value: 'main', code: true },
              { label: 'Ahead', value: 2 },
              { label: 'Clean', value: true, tone: 'success' }
            ]}
          />
        </Card>
        <Card title="Loading">
          <Skeleton lines={3} label="Loading activity" />
        </Card>
      </Grid>
      <Markdown content={README} />
      <CodeView code={SAMPLE} language="typescript" label="greet.ts" lineNumbers />
    </Stack>
  )
}
