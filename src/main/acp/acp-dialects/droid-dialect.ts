import { z } from 'zod'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import {
  ACP_FORM_ELICITATION_METHOD,
  acpFormElicitationPresentation
} from '../requests/acp-form-elicitation'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialect'

const SHELL_EXIT_LINE = /(?:^|\n)\[Process exited with code (-?\d+)\]$/u
const SHELL_FAILURE_LINE = /^Error: Command failed \(exit code: -?\d+\)(?:\n|$)/u
const SHELL_SILENT_SUCCESS = 'Command completed successfully'

// Execute's result is one string: output, then an exit line; a failure also opens with an error line.
function shellResult(output: string): { stdout: string; exitCode: number } | null {
  const exit = SHELL_EXIT_LINE.exec(output)
  if (!exit) {
    return null
  }
  // Trimmed by hand: a regex over a long run of blank lines backtracks quadratically.
  let end = exit.index
  while (end > 0 && output[end - 1] === '\n') {
    end--
  }
  const stdout = output.slice(0, end).replace(SHELL_FAILURE_LINE, '')
  return { stdout: stdout === SHELL_SILENT_SUCCESS ? '' : stdout, exitCode: Number(exit[1]) }
}

// The result string is repeated as a text block.
function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const output = update.rawOutput
  const shell =
    typeof output === 'string' && (update.status === 'completed' || update.status === 'failed')
      ? shellResult(output)
      : null
  if (!shell) {
    return update
  }
  return {
    ...update,
    rawOutput: shell,
    content: update.content?.filter(
      (block) =>
        !(
          block.type === 'content' &&
          block.content.type === 'text' &&
          block.content.text === output
        )
    )
  }
}

// AskUser asks each question as a required choice whose `other` value means "read `<key>_other`".
const OTHER_CHOICE = 'other'
const choicesSchema = z.array(z.looseObject({ const: z.unknown() })).optional()
const askUserFormSchema = z.looseObject({
  mode: z.literal('form'),
  requestedSchema: z.looseObject({
    properties: z.record(
      z.string(),
      z.looseObject({
        type: z.unknown().optional(),
        oneOf: choicesSchema,
        items: z.looseObject({ anyOf: choicesSchema }).optional()
      })
    ),
    required: z.array(z.string()).optional()
  })
})
type AskUserProperty = z.infer<typeof askUserFormSchema>['requestedSchema']['properties'][string]
const acceptedSchema = z.looseObject({
  action: z.literal('accept'),
  content: z.record(z.string(), z.unknown())
})

const isOther = (choice: { const: unknown }) => choice.const === OTHER_CHOICE

function withoutOtherChoice(property: AskUserProperty): AskUserProperty {
  return property.type === 'array'
    ? {
        ...property,
        items: {
          ...property.items,
          anyOf: property.items?.anyOf?.filter((choice) => !isOther(choice))
        }
      }
    : { ...property, oneOf: property.oneOf?.filter((choice) => !isOther(choice)) }
}

// Shown as an optional choice with a text companion, each question fits one card; a typed
// answer goes back as Droid's `other` value.
function askUserForm(method: string, params: unknown): AcpRequestPresentation | undefined {
  const form = method === ACP_FORM_ELICITATION_METHOD && askUserFormSchema.safeParse(params).data
  if (!form) {
    return undefined
  }
  const { properties, required = [] } = form.requestedSchema
  const merged = required.filter((key) => {
    const property = properties[key]
    const choices = property?.type === 'array' ? property.items?.anyOf : property?.oneOf
    return properties[`${key}_other`] !== undefined && choices?.some(isOther)
  })
  if (merged.length === 0) {
    return undefined
  }
  const presentation = acpFormElicitationPresentation({
    ...form,
    requestedSchema: {
      ...form.requestedSchema,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, property]) => [
          key,
          merged.includes(key) ? withoutOtherChoice(property) : property
        ])
      ),
      required: required.filter((key) => !merged.includes(key))
    }
  })
  return {
    ...presentation,
    reply: (response) => {
      const reply = presentation.reply(response)
      const accepted = acceptedSchema.safeParse(reply).data
      if (!accepted) {
        return reply
      }
      const content = { ...accepted.content }
      for (const key of merged.filter((key) => content[`${key}_other`] !== undefined)) {
        const picked = content[key]
        if (properties[key]!.type === 'array') {
          content[key] = [...(Array.isArray(picked) ? picked : []), OTHER_CHOICE]
        } else if (picked === undefined) {
          content[key] = OTHER_CHOICE
        }
      }
      return { ...accepted, content }
    }
  }
}
export const DROID_ACP_DIALECT: AcpDialect = {
  // Without form support Droid cancels AskUser before asking.
  clientCapabilities: { elicitation: { form: {} } },
  request: askUserForm,
  normalizeToolUpdate,
  // Droid's commands are all skills: its own, the user's and the project's.
  skillDescription: ({ description }) => description
}
