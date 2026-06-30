export type ScryerSemanticPath =
  | { kind: 'model'; field?: string }
  | { kind: 'node'; nodeId: string; field?: string }
  | { kind: 'node_responsibility'; nodeId: string; responsibilityId: string; field?: string }
  | { kind: 'node_property'; nodeId: string; label: string; field?: string }
  | { kind: 'link'; linkId: string; field?: string }
  | { kind: 'group'; groupId: string; field?: string }
  | { kind: 'group_responsibility'; groupId: string; responsibilityId: string; field?: string }
  | { kind: 'sourceMap_responsibility'; responsibilityId: string }
  | { kind: 'sourceMap_node'; nodeId: string }
  | { kind: 'sourceMap_raw'; key: string }
  | { kind: 'boundary_node'; nodeId: string }

function enc(value: string): string {
  return encodeURIComponent(value)
}

function dec(value: string): string {
  return decodeURIComponent(value)
}

export const semanticPath = {
  model(field?: string): string {
    return field ? `model.${enc(field)}` : 'model'
  },
  node(nodeId: string, field?: string): string {
    return field ? `node:${enc(nodeId)}.${enc(field)}` : `node:${enc(nodeId)}`
  },
  nodeResponsibility(nodeId: string, responsibilityId: string, field?: string): string {
    const base = `node:${enc(nodeId)}.responsibility:${enc(responsibilityId)}`
    return field ? `${base}.${enc(field)}` : base
  },
  nodeProperty(nodeId: string, label: string, field?: string): string {
    const base = `node:${enc(nodeId)}.property:${enc(label)}`
    return field ? `${base}.${enc(field)}` : base
  },
  link(linkId: string, field?: string): string {
    return field ? `link:${enc(linkId)}.${enc(field)}` : `link:${enc(linkId)}`
  },
  group(groupId: string, field?: string): string {
    return field ? `group:${enc(groupId)}.${enc(field)}` : `group:${enc(groupId)}`
  },
  groupResponsibility(groupId: string, responsibilityId: string, field?: string): string {
    const base = `group:${enc(groupId)}.responsibility:${enc(responsibilityId)}`
    return field ? `${base}.${enc(field)}` : base
  },
  sourceMapResponsibility(responsibilityId: string): string {
    return `sourceMap:responsibility:${enc(responsibilityId)}`
  },
  sourceMapNode(nodeId: string): string {
    return `sourceMap:node:${enc(nodeId)}`
  },
  sourceMapRaw(key: string): string {
    return `sourceMap:${enc(key)}`
  },
  boundaryNode(nodeId: string): string {
    return `boundary:node:${enc(nodeId)}`
  }
}

function splitHeadAndField(value: string): [string, string | undefined] {
  const index = value.indexOf('.')
  return index === -1 ? [value, undefined] : [value.slice(0, index), dec(value.slice(index + 1))]
}

export function parseSemanticPath(value: string): ScryerSemanticPath | null {
  if (value === 'model') {
    return { kind: 'model' }
  }
  if (value.startsWith('model.')) {
    return { kind: 'model', field: dec(value.slice('model.'.length)) }
  }
  if (value.startsWith('link:')) {
    const [head, field] = splitHeadAndField(value.slice('link:'.length))
    return { kind: 'link', linkId: dec(head), field }
  }
  if (value.startsWith('group:')) {
    const body = value.slice('group:'.length)
    const responsibility = body.match(/^(.+)\.responsibility:([^.]*)((?:\..+)?)$/)
    if (responsibility) {
      return {
        kind: 'group_responsibility',
        groupId: dec(responsibility[1]!),
        responsibilityId: dec(responsibility[2]!),
        field: responsibility[3] ? dec(responsibility[3].slice(1)) : undefined
      }
    }
    const [head, field] = splitHeadAndField(body)
    return { kind: 'group', groupId: dec(head), field }
  }
  if (value.startsWith('node:')) {
    const body = value.slice('node:'.length)
    const responsibility = body.match(/^(.+)\.responsibility:([^.]*)((?:\..+)?)$/)
    if (responsibility) {
      return {
        kind: 'node_responsibility',
        nodeId: dec(responsibility[1]!),
        responsibilityId: dec(responsibility[2]!),
        field: responsibility[3] ? dec(responsibility[3].slice(1)) : undefined
      }
    }
    const property = body.match(/^(.+)\.property:([^.]*)((?:\..+)?)$/)
    if (property) {
      return {
        kind: 'node_property',
        nodeId: dec(property[1]!),
        label: dec(property[2]!),
        field: property[3] ? dec(property[3].slice(1)) : undefined
      }
    }
    const [head, field] = splitHeadAndField(body)
    return { kind: 'node', nodeId: dec(head), field }
  }
  if (value.startsWith('sourceMap:responsibility:')) {
    return {
      kind: 'sourceMap_responsibility',
      responsibilityId: dec(value.slice('sourceMap:responsibility:'.length))
    }
  }
  if (value.startsWith('sourceMap:node:')) {
    return { kind: 'sourceMap_node', nodeId: dec(value.slice('sourceMap:node:'.length)) }
  }
  if (value.startsWith('sourceMap:')) {
    return { kind: 'sourceMap_raw', key: dec(value.slice('sourceMap:'.length)) }
  }
  if (value.startsWith('boundary:node:')) {
    return { kind: 'boundary_node', nodeId: dec(value.slice('boundary:node:'.length)) }
  }
  return null
}
