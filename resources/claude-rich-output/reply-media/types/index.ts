import type { PluginState } from 'claude-code'

type RenderResult = PluginState['reply-media']['diagrams'][string]
export type Diagram = Extract<RenderResult, { file: string }>
export type Failure = Extract<RenderResult, { error: string }>
export type Frames = NonNullable<Diagram['frames']>
