import * as z from 'zod'
import { hostRepoCatalogSchema } from '../../host-screen/host-screen-reply-schema'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'

const skill = z.looseObject({ name: z.string(), description: z.string().nullable() })
const ownSkill = skill.extend({ folder: z.string() })

// The shared BotSkillProjectView and BotOwnSkillsView, as the phone reads them.
const scanSchema = z.looseObject({
  projects: z.array(
    z.looseObject({
      repoId: z.string(),
      name: z.string(),
      status: z.enum(['local', 'remote', 'missing']),
      skillsDir: z.string().nullable(),
      skills: z.array(skill)
    })
  ),
  // Absent from a host too old to send the bot's own skills.
  own: z
    .looseObject({ skillsDir: z.string(), skills: z.array(ownSkill), agentOnly: z.array(ownSkill) })
    .optional()
})

export type PhoneSkillScan = z.output<typeof scanSchema>
export type PhoneSkillProject = PhoneSkillScan['projects'][number]

/** Projects' skills as the bot's host reads them, and with `botId` the bot's own. */
export const botSkillProjectsScan = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.skill-projects.scan',
    method: 'bots.skillProjects.scan',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('skill-projects', scanSchema)
  })
)

/** The bot's host's projects, for Link a project. */
export const botSkillHostRepos = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.list-for-bot-skills',
    method: 'repo.list',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('bot-skill-repos', hostRepoCatalogSchema)
  })
)
