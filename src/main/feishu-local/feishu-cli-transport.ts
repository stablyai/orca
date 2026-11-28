import { feishuCliProcess } from './feishu-cli-process'
import { mkdtemp, open, readdir, rm, stat, watch } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { listProfiles, consumeFeishu, feishuCommand } from './feishu-cli'
import { FeishuHostError } from './feishu-cli-status'
import { FeishuPermissionError, FeishuUploadPermissionError } from './feishu-transport'
import type { FeishuTransport } from './feishu-transport'

export function feishuCliTransport(
  app: string,
  profile: string,
  signal: AbortSignal
): FeishuTransport {
  const checkProfile = async () => {
    const profiles = await listProfiles(signal)
    if (!profiles.some((p) => p.appId === app && p.name === profile)) {
      throw new FeishuHostError('profile-changed')
    }
  }
  return {
    async listen(ready, _reconnecting, receive) {
      await checkProfile()
      await consumeFeishu(app, signal, ready, receive)
    },
    async original(mid) {
      await checkProfile()
      const result = await feishuCommand(
        [
          '--profile',
          app,
          'api',
          'GET',
          `/open-apis/im/v1/messages/${mid}`,
          '--params',
          '{"user_id_type":"open_id"}',
          '--as',
          'bot'
        ],
        signal
      )
      return z
        .object({
          ok: z.literal(true),
          identity: z.literal('bot'),
          data: z.object({ items: z.array(z.unknown()) })
        })
        .parse(result).data.items
    },
    async reply(original, chat, message, uuid) {
      await checkProfile()
      // Body on stdin also keeps long replies within Windows' command-line limit.
      const response = await feishuCommand(
        [
          '--profile',
          app,
          'api',
          'POST',
          `/open-apis/im/v1/messages/${original}/reply`,
          '--as',
          'bot',
          '--data',
          '-'
        ],
        signal,
        JSON.stringify({ msg_type: message.type, content: JSON.stringify(message.content), uuid })
      )
      z.object({
        ok: z.literal(true),
        identity: z.literal('bot'),
        data: z.object({
          chat_id: z.literal(chat),
          message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/),
          parent_id: z.literal(original).optional()
        })
      }).parse(response)
    },
    async upload(name, bytes) {
      await checkProfile()
      try {
        const reply = await feishuCommand(
          [
            '--profile',
            app,
            'api',
            'POST',
            '/open-apis/im/v1/files',
            '--as',
            'bot',
            '--file',
            'file=-',
            '--data',
            JSON.stringify({ file_type: 'stream', file_name: name })
          ],
          signal,
          bytes
        )
        return z
          .object({
            ok: z.literal(true),
            identity: z.literal('bot'),
            data: z.object({ file_key: z.string().regex(/^file_[a-zA-Z0-9_-]+$/) })
          })
          .parse(reply).data.file_key
      } catch (error) {
        if (error instanceof FeishuPermissionError) {
          throw new FeishuUploadPermissionError()
        }
        throw error
      }
    },
    async download(mid, key, kind, limit) {
      await checkProfile()
      const dir = await mkdtemp(join(tmpdir(), 'orca-feishu-'))
      const file = join(dir, 'resource.bin')
      const controller = new AbortController()
      const stop = AbortSignal.any([signal, controller.signal])
      const monitor = (async () => {
        try {
          for await (const event of watch(dir, { signal: stop })) {
            const names = event.filename ? [event.filename] : await readdir(dir)
            for (const name of names) {
              const size = await stat(join(dir, name)).then(
                (s) => s.size,
                () => 0
              )
              if (size > limit) {
                controller.abort()
                return
              }
            }
          }
        } catch {
          if (!stop.aborted) {
            controller.abort()
          }
        }
      })()
      try {
        const reply = await runProcess({
          ...(await feishuCliProcess()),
          args: [
            '--profile',
            app,
            'im',
            '+messages-resources-download',
            '--as',
            'bot',
            '--message-id',
            mid,
            '--type',
            kind,
            '--file-key',
            key,
            '--output',
            'resource.bin'
          ],
          cwd: dir,
          detached: process.platform !== 'win32',
          signal: stop,
          timeoutMs: 60_000,
          maxOutputBytes: 64 * 1024
        })
        if (reply.code !== 0 || stop.aborted) {
          throw new Error('Could not download Feishu attachment')
        }
        const h = await open(file, 'r')
        try {
          const info = await h.stat()
          if (!info.isFile() || info.size <= 0 || info.size > limit) {
            throw new Error('Unsupported Feishu attachment size')
          }
          const bytes = await h.readFile()
          stop.throwIfAborted()
          return bytes
        } finally {
          await h.close()
        }
      } finally {
        controller.abort()
        await monitor
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}
