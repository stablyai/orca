import { Badge, Box, Button, Heading, Text } from 'orca'

const SERVICES = [
  { name: 'api', state: 'Healthy', tone: 'success' },
  { name: 'worker', state: 'Degraded', tone: 'warning' },
  { name: 'billing', state: 'Down', tone: 'danger' }
] as const

// Box needs Orca 1.4.248 (ui.catalog 4), hence this plugin's engines floor.
export function LayoutTab() {
  return (
    <Box gap="md">
      <Box
        direction="row"
        gap="sm"
        padding="sm"
        border
        radius="md"
        background="muted"
        align="center"
        justify="between"
      >
        <Heading level={3}>Services</Heading>
        <Button size="sm" variant="outline" icon="refresh">
          Refresh
        </Button>
      </Box>
      <Box columns={3} gap="sm">
        {SERVICES.map((service) => (
          <Box
            key={service.name}
            gap="xs"
            padding="sm"
            border={service.tone}
            radius="md"
            background={service.tone}
          >
            <Text weight="semibold">{service.name}</Text>
            <Badge tone={service.tone}>{service.state}</Badge>
          </Box>
        ))}
      </Box>
      <Box direction="row" gap="sm" wrap>
        <Box
          width="50%"
          minHeight={96}
          padding="sm"
          border
          radius="md"
          background="card"
          scroll="y"
          maxHeight={120}
        >
          <Text muted size="xs">
            Half the width, at least 96px tall, and scrolls past 120px.
          </Text>
          {[
            'Deploy started',
            'Migrations ran',
            'Health checks passed',
            'Traffic shifted',
            'Old pods drained'
          ].map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
        </Box>
        <Box grow padding="sm" border="accent" radius="md" background="accent" justify="center">
          <Text tone="accent">Grows into the rest of the row.</Text>
        </Box>
      </Box>
    </Box>
  )
}
