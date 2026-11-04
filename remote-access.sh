#!/usr/bin/env bash
# ==============================================================================
# Orca Remote Access Manager (Cloudflare Tunnel)
# ==============================================================================
# 用途: 一键开启/关闭本机 Orca 的公网远程安全访问，自动生成 Web端及手机端免密配对链接与配对码。
# 默认状态: 关闭 (默认不开启远程访问，运行此脚本后开启)。
# 域名配置: 优先读取环境变量 ORCA_REMOTE_DOMAIN 或 ~/.config/orca/remote-tunnel.env
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="${1:-start}"

# 加载本地环境配置（该文件置于用户本地 ~/.config/orca/，不纳入版本控制）
CONFIG_ENV="${HOME}/.config/orca/remote-tunnel.env"
if [ -f "$CONFIG_ENV" ]; then
  # shellcheck source=/dev/null
  . "$CONFIG_ENV"
fi
export ORCA_REMOTE_DOMAIN="${ORCA_REMOTE_DOMAIN:-}"

# 终端彩色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

print_banner() {
  echo -e "${CYAN}${BOLD}"
  echo "================================================================================"
  echo "                  Orca Remote Access Manager (Cloudflare Tunnel)                "
  echo "================================================================================"
  echo -e "${NC}"
}

check_orca() {
  if ! ss -tlnp 2>/dev/null | grep -q ':6768 '; then
    echo -e "${YELLOW}[!] 警告: 未检测到本地 Orca 监听端口 6768。${NC}"
    echo -e "    请确认 Orca 桌面客户端已启动并处于运行状态。"
    echo ""
  fi
}

start_services() {
  echo -e "${CYAN}[*] 正在启动远程访问安全通道...${NC}"

  # 1. 启动 SSH 边缘端口转发 (17844 -> Cloudflare 7844)
  systemctl --user start cloudflared-edge-forward.service

  # 等待转发就绪
  local wait_count=0
  while ! nc -z 127.0.0.1 17844 2>/dev/null; do
    sleep 0.5
    wait_count=$((wait_count + 1))
    if [ "$wait_count" -ge 20 ]; then
      echo -e "${RED}[✗] SSH 边缘转发 (17844) 启动超时，请检查网络或 systemctl --user status cloudflared-edge-forward${NC}"
      exit 1
    fi
  done

  # 2. 启动 Cloudflare Named Tunnel
  systemctl --user start cloudflared-named-tunnel.service
  sleep 1.5

  if systemctl --user is-active --quiet cloudflared-named-tunnel.service; then
    local display_domain="${ORCA_REMOTE_DOMAIN:-remote tunnel}"
    echo -e "${GREEN}[✔] 远程隧道已建立并保持在线 (${display_domain})${NC}"
  else
    echo -e "${RED}[✗] Cloudflare 隧道启动失败，请检查 systemctl --user status cloudflared-named-tunnel${NC}"
    exit 1
  fi
  echo ""
}

stop_services() {
  echo -e "${CYAN}[*] 正在关闭远程访问通道...${NC}"
  systemctl --user stop cloudflared-named-tunnel.service 2>/dev/null || true
  systemctl --user stop cloudflared-edge-forward.service 2>/dev/null || true
  echo -e "${GREEN}[✔] 远程访问已安全关闭（隧道与转发已停止）。${NC}"
}

check_status() {
  print_banner
  local fwd_active="inactive"
  local tun_active="inactive"
  local orca_status="offline"

  if systemctl --user is-active --quiet cloudflared-edge-forward.service; then
    fwd_active="${GREEN}active (running)${NC}"
  else
    fwd_active="${RED}inactive (stopped)${NC}"
  fi

  if systemctl --user is-active --quiet cloudflared-named-tunnel.service; then
    tun_active="${GREEN}active (running)${NC}"
  else
    tun_active="${RED}inactive (stopped)${NC}"
  fi

  if ss -tlnp 2>/dev/null | grep -q ':6768 '; then
    orca_status="${GREEN}online (port 6768)${NC}"
  else
    orca_status="${YELLOW}offline (port 6768 not listening)${NC}"
  fi

  echo -e "服务状态检查:"
  echo -e "  - 本地 Orca 实例:    ${orca_status}"
  echo -e "  - SSH 边缘穿透转发:  ${fwd_active}"
  echo -e "  - Cloudflare 隧道:   ${tun_active}"
  echo ""

  if systemctl --user is-active --quiet cloudflared-named-tunnel.service; then
    echo -e "${GREEN}当前远程访问已开启。使用 ./remote-access.sh stop 可随时关闭。${NC}"
    echo ""
    generate_credentials "status_only"
  else
    echo -e "${YELLOW}当前远程访问处于关闭状态。运行 ./remote-access.sh 即可开启。${NC}"
  fi
}

generate_credentials() {
  local mode="${1:-generate}"
  node - "$mode" << 'EOF'
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const mode = process.argv[2] || 'generate';
const orcaDir = path.join(os.homedir(), '.config', 'orca');
const keypairFile = path.join(orcaDir, 'orca-e2ee-keypair.json');
const devicesFile = path.join(orcaDir, 'orca-devices.json');
const weeklyFile = path.join(orcaDir, 'remote-access-weekly.json');

if (!fs.existsSync(keypairFile)) {
  console.error('\x1b[31m[✗] 未找到 Orca E2EE 密钥文件: ' + keypairFile + '\x1b[0m');
  console.error('    请先在本地启动一次 Orca 客户端以生成加密密钥对。');
  process.exit(1);
}

const keypair = JSON.parse(fs.readFileSync(keypairFile, 'utf8'));
let devices = [];
if (fs.existsSync(devicesFile)) {
  try {
    devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
  } catch (e) {
    devices = [];
  }
}

const rawDomain = (process.env.ORCA_REMOTE_DOMAIN || 'localhost:6768').trim();
const domain = rawDomain.startsWith('http://') || rawDomain.startsWith('https://')
  ? rawDomain
  : (rawDomain.includes('localhost') ? `http://${rawDomain}` : `https://${rawDomain}`);
const endpoint = domain.startsWith('https://')
  ? `wss://${domain.slice(8)}`
  : (domain.startsWith('http://') ? `ws://${domain.slice(7)}` : `wss://${domain}`);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const now = Date.now();

// 1. Weekly / Long-Term Token Logic
let weekly = null;
if (fs.existsSync(weeklyFile)) {
  try {
    weekly = JSON.parse(fs.readFileSync(weeklyFile, 'utf8'));
  } catch (_) {}
}

const isWeeklyExpired = !weekly || !weekly.expiresAt || now >= weekly.expiresAt || mode === 'rotate';
let wkDeviceId, wkToken, wkCode, wkExpiresAt;

if (isWeeklyExpired || !devices.some(d => d.deviceId === weekly?.deviceId)) {
  if (weekly?.deviceId) {
    devices = devices.filter(d => d.deviceId !== weekly.deviceId);
  }
  wkDeviceId = crypto.randomUUID();
  wkToken = crypto.randomBytes(24).toString('hex');
  wkExpiresAt = now + WEEK_MS;
  const wkOffer = {
    v: 2,
    endpoint,
    deviceToken: wkToken,
    publicKeyB64: keypair.publicKeyB64,
    pairedDeviceId: wkDeviceId,
    scope: 'runtime'
  };
  wkCode = Buffer.from(JSON.stringify(wkOffer)).toString('base64url');

  devices.push({
    deviceId: wkDeviceId,
    token: wkToken,
    name: 'Weekly Remote Access (7-Days)',
    scope: 'runtime',
    pairedAt: now,
    lastSeenAt: 0,
    pairingReach: 'network',
    managedTag: 'weekly'
  });

  fs.writeFileSync(weeklyFile, JSON.stringify({
    deviceId: wkDeviceId,
    token: wkToken,
    createdAt: now,
    expiresAt: wkExpiresAt,
    pairCode: wkCode
  }, null, 2), { mode: 0o600 });
} else {
  wkDeviceId = weekly.deviceId;
  wkToken = weekly.token;
  wkCode = weekly.pairCode;
  wkExpiresAt = weekly.expiresAt;
}

// 2. One-Time Token (if generating)
let otCode = null;
if (mode === 'generate') {
  const otDeviceId = crypto.randomUUID();
  const otToken = crypto.randomBytes(24).toString('hex');
  const otOffer = {
    v: 2,
    endpoint,
    deviceToken: otToken,
    publicKeyB64: keypair.publicKeyB64,
    pairedDeviceId: otDeviceId,
    scope: 'runtime'
  };
  otCode = Buffer.from(JSON.stringify(otOffer)).toString('base64url');

  devices.push({
    deviceId: otDeviceId,
    token: otToken,
    name: `One-Time Web (${new Date(now).toISOString().slice(0, 16).replace('T', ' ')})`,
    scope: 'runtime',
    pairedAt: now,
    lastSeenAt: 0,
    pairingReach: 'network',
    managedTag: 'one-time'
  });
}

// Clean up stale one-time devices older than 24h
devices = devices.filter(d => {
  if (d.managedTag === 'one-time' && (now - d.pairedAt > 24 * 3600 * 1000)) {
    return false;
  }
  return true;
});

// Write devices.json atomically
const tmpFile = devicesFile + '.tmp.' + now;
fs.writeFileSync(tmpFile, JSON.stringify(devices, null, 2), { mode: 0o600 });
fs.renameSync(tmpFile, devicesFile);

// Formatted Output
const daysLeft = Math.max(0, Math.ceil((wkExpiresAt - now) / (24 * 3600 * 1000)));
const expireDateStr = new Date(wkExpiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

console.log('\x1b[1m\x1b[32m================================================================================\x1b[0m');
console.log('\x1b[1m\x1b[32m                     【1. 长期访问凭据 (每周重置一次)】                         \x1b[0m');
console.log('\x1b[1m\x1b[32m================================================================================\x1b[0m');
console.log(`\x1b[33m[⏳ 有效期]\x1b[0m 剩余约 \x1b[1m${daysLeft} 天\x1b[0m (到期时间: ${expireDateStr}，到期后自动更新)`);
console.log('');
console.log('\x1b[1m\x1b[36m💻 Web端完整访问 (桌面大屏自动配对链接):\x1b[0m');
console.log(`\x1b[4m${domain}/web-index.html#pairing=${wkCode}\x1b[0m`);
console.log('');
console.log('\x1b[1m\x1b[36m📱 手机浏览器适配访问 (小屏幕移动端专属界面，自动配对):\x1b[0m');
console.log(`\x1b[4m${domain}/remote#pairing=${wkCode}\x1b[0m`);
console.log('');
console.log('\x1b[1m\x1b[36m🔑 长期 PairCode (配对码):\x1b[0m');
console.log(wkCode);
console.log('');
console.log('\x1b[1m\x1b[36m🔗 长期 App Deep Link (可在手机/客户端直接唤醒):\x1b[0m');
console.log(`orca://pair?code=${wkCode}`);
console.log('');

if (otCode) {
  console.log('\x1b[1m\x1b[33m================================================================================\x1b[0m');
  console.log('\x1b[1m\x1b[33m                     【2. 一次性访问凭据 (临时配对)】                           \x1b[0m');
  console.log('\x1b[1m\x1b[33m================================================================================\x1b[0m');
  console.log('\x1b[33m[📌 说明]\x1b[0m 专为临时或单次访问生成，配对后可在设备列表中随时撤回。');
  console.log('');
  console.log('\x1b[1m\x1b[36m💻 Web端临时访问链接 (自动配对):\x1b[0m');
  console.log(`\x1b[4m${domain}/web-index.html#pairing=${otCode}\x1b[0m`);
  console.log('');
  console.log('\x1b[1m\x1b[36m📱 手机端临时适配链接 (自动配对):\x1b[0m');
  console.log(`\x1b[4m${domain}/remote#pairing=${otCode}\x1b[0m`);
  console.log('');
  console.log('\x1b[1m\x1b[36m🔑 一次性 PairCode (配对码):\x1b[0m');
  console.log(otCode);
  console.log('');
  console.log('\x1b[1m\x1b[36m🔗 一次性 App Deep Link:\x1b[0m');
  console.log(`orca://pair?code=${otCode}`);
  console.log('');
}

console.log('\x1b[1m\x1b[35m================================================================================\x1b[0m');
console.log('\x1b[1m\x1b[35m                      【3. 移动端与 PIN 码使用指南】                             \x1b[0m');
console.log('\x1b[1m\x1b[35m================================================================================\x1b[0m');
console.log('\x1b[1mQ: 为什么 PairCode 是一长串字符，不能直接设为类似 123456 的纯数字 PIN 码？\x1b[0m');
console.log('A: Orca 采用端到端强加密 (E2EE Curve25519) 通信，配对码中内嵌了服务端的 256 位非对称加密公钥、');
console.log(`   设备身份令牌及 ${endpoint} 寻址信息。这保证了即使流量穿透公网隧道，任何人`);
console.log('   （包括中间运营商）都无法窃听或解密你的代码与指令。');
console.log('');
console.log('\x1b[1m✨ 最推荐的日常极简使用方式（完全无需手动输入任何长代码或 PIN 码）:\x1b[0m');
console.log('1. 在手机浏览器中直接点击打开上述 \x1b[1m📱 手机浏览器适配访问链接\x1b[0m。');
console.log('2. 页面打开后，Orca 会自动完成配对，并将安全密钥持久保存在手机本地 (localStorage)。');
console.log(`3. \x1b[1m后续使用\x1b[0m: 直接在手机浏览器打开 \x1b[1m${domain}/remote\x1b[0m 即可秒进！`);
console.log('   （无需重复输入任何代码，可将网页直接“添加到手机主屏幕”作为独立 Web App 使用）');
console.log('4. \x1b[1m每周重置\x1b[0m: 若要强制提前重置长期凭据，可运行 \x1b[1m./remote-access.sh rotate\x1b[0m。');
console.log('5. \x1b[1m停止访问\x1b[0m: 运行 \x1b[1m./remote-access.sh stop\x1b[0m 即可瞬间关闭公网隧道。');
console.log('\x1b[1m\x1b[32m================================================================================\x1b[0m');
EOF
}

case "$COMMAND" in
  start|"")
    print_banner
    check_orca
    start_services
    generate_credentials "generate"
    ;;
  stop)
    print_banner
    stop_services
    ;;
  status)
    check_status
    ;;
  rotate|reset)
    print_banner
    echo -e "${YELLOW}[*] 正在轮换长期配对凭据并注销旧设备...${NC}"
    generate_credentials "rotate"
    echo -e "${GREEN}[✔] 长期配对凭据已轮换更新！旧凭据已失效。${NC}"
    ;;
  links)
    print_banner
    generate_credentials "status_only"
    ;;
  help|-h|--help)
    print_banner
    echo "用法: $0 [命令]"
    echo ""
    echo "可用命令:"
    echo "  start       启动远程访问通道并生成访问链接（默认动作）"
    echo "  stop        关闭远程访问通道（隧道及端口转发停止）"
    echo "  status      查看通道状态及当前有效凭据信息"
    echo "  rotate      强制重置/轮换长期访问凭据（使旧链接失效）"
    echo "  links       仅显示当前有效凭据及链接（不改变服务运行状态）"
    echo "  help        显示此帮助信息"
    echo ""
    ;;
  *)
    echo -e "${RED}[✗] 未知命令: $COMMAND${NC}"
    echo "使用 $0 help 查看帮助。"
    exit 1
    ;;
esac
