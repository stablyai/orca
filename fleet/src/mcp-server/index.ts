#!/usr/bin/env node
/**
 * ============================================================================
 * ORCA FLEET MCP SERVER (fleet/src/mcp-server/index.ts)
 * Model Context Protocol (MCP) server cho phép Antigravity điều khiển trực tiếp
 * Orca Runtime qua Windows Named Pipe JSON-RPC.
 * ============================================================================
 */

import { orca } from '../orca-rpc-client/index.ts';
import * as readline from 'node:readline';

const SERVER_NAME = 'orca-fleet';
const SERVER_VERSION = '1.0.0';

// Danh sách các Tools cung cấp cho Antigravity
const TOOLS = [
  {
    name: 'orca_status',
    description: 'Kiểm tra trạng thái kết nối tới Orca Desktop Runtime (PID, version, shell, graph status).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'orca_list_worktrees',
    description: 'Liệt kê danh sách tất cả các Git Worktrees hiện có trong Orca cùng trạng thái hoạt động.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Số lượng worktree tối đa cần lấy (mặc định 50)',
        },
      },
    },
  },
  {
    name: 'orca_start_worker',
    description: 'Tạo một Git Worktree mới, mở terminal, khởi chạy agent (claude, opencode, codex, gemini) và tiêm đề bài/prompt spec trong 1 lệnh duy nhất.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: {
          type: 'string',
          description: 'Nhiệm vụ, đề bài, hoặc hướng dẫn chi tiết cho worker agent.',
        },
        repo: {
          type: 'string',
          description: 'Đường dẫn hoặc selector của repository (vd: "path:G:/DSHarness" hoặc để trống để dùng repo mặc định).',
        },
        name: {
          type: 'string',
          description: 'Tên nhánh/thư mục worktree cần tạo (vd: "task-142-fix-login").',
        },
        displayName: {
          type: 'string',
          description: 'Tên hiển thị thân thiện trên tab Orca (vd: "#142 Sửa lỗi login").',
        },
        agent: {
          type: 'string',
          description: 'Agent thực thi: "claude", "opencode" (dành cho DeepSeek), "gemini", hoặc "codex". Mặc định "claude".',
        },
        baseBranch: {
          type: 'string',
          description: 'Nhánh gốc để rẽ nhánh (vd: "master" hoặc "main").',
        },
        issue: {
          type: 'number',
          description: 'Số GitHub Issue liên kết nếu có (vd: 142).',
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'orca_check_worker',
    description: 'Kiểm tra tiến độ hoặc chờ worker agent báo hoàn thành (worker_done, escalation, question).',
    inputSchema: {
      type: 'object',
      properties: {
        wait: {
          type: 'boolean',
          description: 'Nếu true, sẽ giữ kết nối chờ agent hoàn thành (mặc định true).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Thời gian chờ tối đa bằng mili-giây (mặc định 120000 = 2 phút).',
        },
      },
    },
  },
  {
    name: 'orca_list_terminals',
    description: 'Liệt kê các terminal đang mở trong Orca (kèm handle để gửi/đọc lệnh).',
    inputSchema: {
      type: 'object',
      properties: {
        worktree: {
          type: 'string',
          description: 'Selector worktree cần lọc (tuỳ chọn).',
        },
      },
    },
  },
  {
    name: 'orca_send_terminal',
    description: 'Gửi văn bản hoặc câu lệnh vào một terminal trong Orca.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalHandle: {
          type: 'string',
          description: 'Handle của terminal cần gửi (lấy từ orca_list_terminals).',
        },
        text: {
          type: 'string',
          description: 'Câu lệnh hoặc prompt cần gửi.',
        },
        enter: {
          type: 'boolean',
          description: 'Có tự động bấm Enter sau khi gửi không (mặc định true).',
        },
      },
      required: ['terminalHandle', 'text'],
    },
  },
  {
    name: 'orca_read_terminal',
    description: 'Đọc output log mới nhất từ một terminal trong Orca.',
    inputSchema: {
      type: 'object',
      properties: {
        terminalHandle: {
          type: 'string',
          description: 'Handle của terminal cần đọc.',
        },
        limit: {
          type: 'number',
          description: 'Số dòng log tối đa cần đọc (mặc định 50).',
        },
      },
      required: ['terminalHandle'],
    },
  },
];

// Hàm xử lý gọi Tool
async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<any> {
  switch (name) {
    case 'orca_status':
      return await orca.getStatus();

    case 'orca_list_worktrees':
      return await orca.listWorktrees(args.limit ?? 50);

    case 'orca_start_worker':
      return await orca.startWorker({
        spec: args.spec,
        repo: args.repo,
        name: args.name,
        displayName: args.displayName,
        agent: args.agent || 'claude',
        baseBranch: args.baseBranch,
        issue: args.issue,
        worktree: 'new-top-level',
      });

    case 'orca_check_worker':
      return await orca.checkOrchestration({
        wait: args.wait ?? true,
        timeoutMs: args.timeoutMs ?? 120_000,
      });

    case 'orca_list_terminals':
      return await orca.listTerminals(args.worktree);

    case 'orca_send_terminal':
      return await orca.sendTerminal(args.terminalHandle, args.text, args.enter ?? true);

    case 'orca_read_terminal':
      return await orca.readTerminal(args.terminalHandle, args.limit ?? 50);

    default:
      throw new Error(`Tool '${name}' không tồn tại.`);
  }
}

// Xử lý JSON-RPC qua stdio
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function sendResponse(id: any, result: any, error?: any) {
  const res: any = { jsonrpc: '2.0', id };
  if (error) {
    res.error = {
      code: error.code || -32603,
      message: error.message || String(error),
      data: error.data,
    };
  } else {
    res.result = result;
  }
  process.stdout.write(JSON.stringify(res) + '\n');
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: any;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    return;
  }

  const { id, method, params } = req;

  // Xử lý các phương thức MCP chuẩn
  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        });
        break;

      case 'notifications/initialized':
        // MCP client gửi thông báo sau khi hoàn tất handshake
        break;

      case 'ping':
        sendResponse(id, {});
        break;

      case 'tools/list':
        sendResponse(id, {
          tools: TOOLS,
        });
        break;

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          const result = await handleToolCall(toolName, toolArgs);
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          });
        } catch (callErr: any) {
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `[Orca MCP Error]: ${callErr.message || String(callErr)}`,
              },
            ],
            isError: true,
          });
        }
        break;
      }

      default:
        if (id !== undefined) {
          sendResponse(id, null, { code: -32601, message: `Method '${method}' not found` });
        }
        break;
    }
  } catch (globalErr: any) {
    if (id !== undefined) {
      sendResponse(id, null, { code: -32603, message: globalErr.message || 'Internal error' });
    }
  }
});

// Giữ tiến trình không thoát khi idle
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
